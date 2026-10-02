import { randomUUID } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { SylloraError, SylloraService } from './syllora.ts'
import { normalizeCourse, type Course } from './syllora-domain.ts'
import { atomicJson, jsonFile, managedDirectory, removeProducts, scanFiles, sha, SOURCE_LIMIT, stateDirectory, within } from './syllora-files.ts'
import { loadChatConfig } from './config.ts'

import { courseIconSchema, defaultUiPreferences, uiPreferencesSchema, type UiPreferences } from './syllora-ui.ts'

interface Project { id:string;path:string;name:string;deletion?:'pending'|'failed' }
interface Preferences { consent:boolean }
interface StoredCourse { version:1;courses:Course[];jobs:unknown[];calls:number;consent:boolean }
type Options=NonNullable<ConstructorParameters<typeof SylloraService>[1]> & { registerProject?: (path:string)=>Promise<void>; managedCoursesRoot?:string }

/** Fixed application root holds only shared settings and recent paths. Every course owns its own service. */
export class SylloraProjects {
  private projects:Project[]=[]
  private relocationErrors=new Map<string,string>()
  private services=new Map<string,SylloraService>()
  private ready:Promise<void>|null=null
  private tail:Promise<unknown>=Promise.resolve()
  private deleting=new Set<string>()
  private courseOperations=new Map<string,string>()
  constructor(readonly root:string,private readonly options:Options={}) {}
  async readMaterialFile(courseId:string,materialId:string) {
    if(!z.string().uuid().safeParse(courseId).success||!z.string().uuid().safeParse(materialId).success)throw new SylloraError('INVALID_REQUEST','课程或资料 ID 不正确')
    return (await this.service(courseId)).readMaterialFile(courseId,materialId)
  }
  private async load() {
    this.ready??=(async()=>{
      await mkdir(this.root,{recursive:true});await stateDirectory(this.root)
      this.projects=await jsonFile<Project[]>(join(this.root,'.syllora','projects.json'))??[]
      if(this.options.managedCoursesRoot)await this.relocateCourses()
    })()
    await this.ready
  }
  private async serialize<T>(fn:()=>Promise<T>) {
    const next=this.tail.then(async()=>{await this.load();return fn()});this.tail=next.catch(()=>undefined);return next
  }
  // The local app allows calls to user-configured providers without a separate toggle.
  // Old persisted consent:false values must not block existing installations.
  private async preferences():Promise<Preferences> { return {consent:true} }
  private async uiPreferences():Promise<UiPreferences> {
    const saved=await jsonFile<UiPreferences>(join(this.root,'.syllora','ui-preferences.json'))
    return saved?{...uiPreferencesSchema.parse(saved),revision:z.number().int().min(0).parse(saved.revision)}:defaultUiPreferences()
  }
  private makeService(project:Project) {
    return new SylloraService(join(project.path,'.syllora'),{...this.options,fileName:'course.json',courseRoot:project.path,config:this.options.config??(()=>loadChatConfig(this.root)),isConsented:async()=>(await this.preferences()).consent})
  }
  private async service(id:string,allowDeleting=false) {
    await this.load()
    const project=this.projects.find(p=>p.id===id)
    if(!project)throw new SylloraError('NOT_FOUND','课程未打开，请先打开课程文件夹')
    if((this.deleting.has(id)||project.deletion)&&!allowDeleting)throw new SylloraError('DELETING','课程删除未完成，已停止学习读写；请重试清理，原始资料保留')
    if(!(await stat(project.path).catch(()=>null))?.isDirectory())throw new SylloraError('FOLDER_MISSING','课程文件夹已移动或不存在，请重新打开')
    await stateDirectory(project.path)
    let service=this.services.get(id)
    if(!service){service=this.makeService(project);this.services.set(id,service)}
    return service
  }
  private async remember(project:Project) {
    this.projects=[project,...this.projects.filter(p=>p.id!==project.id&&p.path!==project.path)]
    await atomicJson(join(this.root,'.syllora','projects.json'),this.projects)
    await this.options.registerProject?.(project.path)
  }
  /** The course root is independent of shared settings/credentials. Never silently fall back. */
  private async managedRoot() {
    const path=resolve(this.options.managedCoursesRoot??join(this.root,'.syllora'))
    await mkdir(path,{recursive:true})
    if(await realpath(path)!==path)throw new SylloraError('INVALID_FOLDER','课程存储目录不能是目录链接')
    return path
  }
  private async createManaged(payload:unknown) {
    const p=z.object({requestId:z.string().uuid(),name:z.string().trim().min(1).max(60),timezone:z.string().default('Asia/Shanghai'),icon:courseIconSchema.optional()}).parse(payload)
    return this.serialize(async()=>{
      const root=await managedDirectory(await this.managedRoot(),p.requestId),dir=await stateDirectory(root)
      const creationFile=join(dir,'creation.json'),previous=await jsonFile<{name:string;timezone:string;icon?:string}>(creationFile)
      const identity={name:p.name,timezone:p.timezone,...(p.icon?{icon:p.icon}:{})}
      if(previous&&JSON.stringify(previous)!==JSON.stringify(identity))throw new SylloraError('REQUEST_CONFLICT','此创建请求已用于另一门课程，请重新发起')
      if(!previous)await atomicJson(creationFile,identity)
      const stored=await jsonFile<StoredCourse>(join(dir,'course.json'))
      if(stored&&stored.courses[0]?.id!==p.requestId)throw new SylloraError('COURSE_EXISTS','课程存储目录已有其他课程，不会覆盖')
      if(stored&&this.projects.some(project=>project.id===p.requestId&&project.path===root))return {id:p.requestId,path:root,created:false}
      return this.openFolderUnlocked({...p,path:root},p.requestId)
    })
  }
  /** Copy course files and published history before switching the durable registry.
   * Original folders are retained. Failed copies keep the old course usable and can retry on restart. */
  private async relocateCourses() {
    for(const project of [...this.projects]) {
      if(project.deletion)continue
      try {
        z.string().uuid().parse(project.id)
        const base=await this.managedRoot(),destination=join(base,project.id)
        if(resolve(project.path)===destination)continue
        const source=await realpath(project.path),stateDir=await stateDirectory(source)
        const snapshot=await jsonFile<StoredCourse>(join(stateDir,'course.json'))
        if(!snapshot||snapshot.courses.length!==1||snapshot.courses[0]?.id!==project.id)throw new Error('课程状态与目录身份不一致')
        const files=await scanFiles(source,snapshot.courses[0]!.materials)
        const stamp={source,courseId:project.id,snapshot:sha(JSON.stringify(snapshot)),files:files.map(file=>({path:file.path,size:file.size,fingerprint:file.fingerprint}))}
        let staging:string|null=null
        if(await lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error})) {
          if(await realpath(destination)!==destination)throw new Error('目标课程目录不能是目录链接')
          const copied=await jsonFile<StoredCourse>(join(await stateDirectory(destination),'course.json'))
          const previous=await jsonFile(join(destination,'.syllora','relocation.json'))
          if(JSON.stringify(previous)!==JSON.stringify(stamp)||sha(JSON.stringify(copied))!==stamp.snapshot)throw new Error('目标课程目录已存在，迁移不会覆盖')
        } else {
          staging=await managedDirectory(base,`.migration-${project.id}-${randomUUID()}`)
          await cp(stateDir,join(staging,'.syllora'),{recursive:true,errorOnExist:true,force:false,filter:async path=>{if((await lstat(path)).isSymbolicLink())throw new Error('课程记录含目录或文件链接');return !['config.yaml','credentials.json'].includes(basename(path))}})
          for(const file of files) {
            const original=await within(source,file.path),target=join(staging,file.path)
            await mkdir(resolve(target,'..'),{recursive:true});await copyFile(original,target)
            if(file.fingerprint&&sha(await readFile(target))!==file.fingerprint)throw new Error('迁移期间原始资料发生变化，请重试')
          }
          if(sha(JSON.stringify(await jsonFile<StoredCourse>(join(stateDir,'course.json'))))!==stamp.snapshot)throw new Error('迁移期间课程记录发生变化，请关闭其他实例后重试')
          await atomicJson(join(staging,'.syllora','relocation.json'),stamp)
          await rename(staging,destination)
        }
        const updated=this.projects.map(item=>item.id===project.id?{...item,path:destination}:item)
        try {
          await this.options.registerProject?.(destination)
          await atomicJson(join(this.root,'.syllora','projects.json'),updated)
        } catch(error) {if(staging)await rename(destination,staging);throw error}
        this.projects=updated
      } catch(error) {this.relocationErrors.set(project.id,`课程迁移未完成，原目录保留：${error instanceof Error?error.message:'存储错误'}`)}
    }
  }
  private async openFolder(payload:unknown,identity?:string) {
    const p=z.object({path:z.string().trim().min(1),name:z.string().trim().min(1).max(60).optional(),timezone:z.string().default('Asia/Shanghai'),icon:courseIconSchema.optional()}).parse(payload)
    return this.serialize(()=>this.openFolderUnlocked(p,identity))
  }
  private async openFolderUnlocked(p:{path:string;name?:string|undefined;timezone:string;icon?:z.infer<typeof courseIconSchema>|undefined},identity?:string) {
      const root=await realpath(resolve(p.path))
      if(this.projects.some(project=>project.path===root&&(project.deletion||this.deleting.has(project.id))))throw new SylloraError('DELETING','课程删除未完成，请先重试清理，不能重新打开')
      if(!(await stat(root)).isDirectory())throw new SylloraError('INVALID_FOLDER','请选择课程文件夹')
      const stateDir=await stateDirectory(root), stored=await jsonFile<StoredCourse>(join(stateDir,'course.json'))
      if(stored&&(stored.version!==1||stored.courses.length!==1))throw new SylloraError('STORAGE_ERROR','课程状态格式不正确，请保留文件并检查')
      const courseId=stored?.courses[0]?.id??identity??randomUUID()
      z.string().uuid().parse(courseId)
      if(this.deleting.has(courseId))throw new SylloraError('DELETING','课程正在删除，请稍后重试')
      const old=this.projects.find(v=>v.id===courseId&&v.path!==root)
      if(old&&(await stat(old.path).catch(()=>null))?.isDirectory())throw new SylloraError('DUPLICATE_COURSE','另一位置已有相同课程身份；请使用原课程目录或先移走原目录')
      const project={id:courseId,path:root,name:stored?.courses[0]?.name??p.name??basename(root).slice(0,60)}
      const previous=this.projects.find(v=>v.id===courseId&&v.path===root)
      const service=(previous?this.services.get(courseId):undefined)??this.makeService(project)
      if(!stored)await service.handle('create',{requestId:courseId,name:project.name,timezone:p.timezone})
      if(p.icon)await service.handle('coursePresentation',{courseId,icon:p.icon})
      this.services.set(courseId,service);await this.remember(project)
      return {id:courseId,path:root,created:!stored}
  }
  async handle(action:string,payload:unknown):Promise<unknown> {
    await this.load()
    if(action==='uiPreferences')return this.serialize(async()=>{
      const current=await this.uiPreferences()
      if(!payload||typeof payload!=='object'||!('baseVersion' in payload)){z.object({}).strict().parse(payload??{});return current}
      const p=uiPreferencesSchema.extend({baseVersion:z.number().int().min(0)}).parse(payload)
      if(p.baseVersion!==current.revision)throw new SylloraError('VERSION_CONFLICT','界面偏好已在另一页面更新；输入已保留，请加载最新设置后重试')
      const saved:UiPreferences={name:p.name,theme:p.theme,dailyMinutes:p.dailyMinutes,revision:current.revision+1}
      await atomicJson(join(this.root,'.syllora','ui-preferences.json'),saved)
      return saved
    })
    if(action==='activity') {const state=await this.handle('state',{}) as {courses:Course[]};return {activity:state.courses.flatMap(course=>course.activity??[])}}
    if(action==='createCourse')return this.createManaged(payload)
    if(action==='openCourse')return this.openFolder(payload)
    if(action==='preferences') {
      // Compatibility endpoint for older UI clients; effective policy stays enabled.
      z.object({consent:z.boolean()}).parse(payload)
      await atomicJson(join(this.root,'.syllora','preferences.json'),{consent:true})
      return {saved:true}
    }
    if(action==='state') {
      const courses:unknown[]=[], jobs:unknown[]=[], projects:Array<Project&{error:string|null}>=[];let calls=0
      for(const project of this.projects) {
        try {
          const result=await (await this.service(project.id)).handle('state',{}) as {courses:Course[];jobs:unknown[];settings:{calls:number}}
          courses.push(...result.courses.map(c=>({...c,folder:project.path})));jobs.push(...result.jobs);calls+=result.settings.calls
          projects.push({...project,name:result.courses[0]?.name??project.name,error:this.relocationErrors.get(project.id)??null})
        } catch(error) { projects.push({...project,error:error instanceof Error?error.message:'课程无法读取'}) }
      }
      const legacy=await jsonFile<StoredCourse>(join(this.root,'syllora.json'))
      return {courses,jobs,uiPreferences:await this.uiPreferences(),activity:courses.flatMap(course=>(course as Course).activity??[]),projects,legacyCourses:(legacy?.courses??[]).filter(c=>!this.projects.some(p=>p.id===c.id)).map(c=>({id:c.id,name:c.name,points:c.points.length})),settings:{...(await this.preferences()),calls:calls+(legacy?.calls??0)}}
    }
    // Compatibility alias; creation now always uses an application-managed directory.
    if(action==='create')return this.createManaged(payload)
    if(action==='migrateCourse')return this.migrate(payload)
    const p=z.object({courseId:z.string().uuid()}).passthrough().parse(payload)
    if(action==='delete'&&this.courseOperations.get(p.courseId)==='deleteMaterial')throw new SylloraError('COURSE_BUSY','本课程正在删除资料并收束旧任务，请等待原操作完成后重试')
    if(['deleteMaterial','initialize','generate','import'].includes(action))return this.courseOperation(p.courseId,action,()=>this.handleCourse(action,payload,p))
    return this.handleCourse(action,payload,p)
  }
  /** Launches and destructive cleanup share this guard; workers run outside it, deletion drains them inside it. */
  private async courseOperation<T>(courseId:string,action:string,run:()=>Promise<T>):Promise<T> {
    if(this.courseOperations.has(courseId))throw new SylloraError('COURSE_BUSY','本课程正在启动生成或清理资料，请查询原操作结果，完成后再试')
    this.courseOperations.set(courseId,action)
    try{return await run()}finally{this.courseOperations.delete(courseId)}
  }
  private async handleCourse(action:string,payload:unknown,p:{courseId:string;[key:string]:unknown}):Promise<unknown> {
    const service=await this.service(p.courseId,action==='delete')
    if(action==='delete') {
      if(p['confirmed']!==true)throw new SylloraError('CONFIRMATION_REQUIRED','请确认删除课程整理产物与学习记录')
      if(this.deleting.has(p.courseId))throw new SylloraError('DELETING','课程正在清理，请查询原操作结果，不要重复发起删除')
      this.deleting.add(p.courseId)
      let marked=false
      try {
        // Persist the intent before any cleanup; restart must not reopen a partially removed course.
        await this.serialize(async()=>{
          const pending=this.projects.map(project=>project.id===p.courseId?{...project,deletion:'pending' as const}:project)
          await atomicJson(join(this.root,'.syllora','projects.json'),pending);this.projects=pending;marked=true
        })
        await service.prepareDeletion()
        await removeProducts(this.projects.find(v=>v.id===p.courseId)!.path,['revisions','.staging','course.json'])
        await this.serialize(async()=>{
          const remaining=this.projects.filter(v=>v.id!==p.courseId)
          await atomicJson(join(this.root,'.syllora','projects.json'),remaining);this.projects=remaining;this.services.delete(p.courseId)
        })
        return {saved:true}
      } catch(error) {
        if(marked)await this.serialize(async()=>{
          const failed=this.projects.map(project=>project.id===p.courseId?{...project,deletion:'failed' as const}:project)
          await atomicJson(join(this.root,'.syllora','projects.json'),failed);this.projects=failed
        }).catch(()=>undefined) // The durable pending marker remains if recording the failure also fails.
        throw new SylloraError(marked?'DELETE_INCOMPLETE':'STORAGE_ERROR',marked?'课程删除未完成，已停止学习读写；请重试清理，原始资料保留':'无法保存删除状态，尚未开始清理；请检查目录后重试')
      } finally {this.deleting.delete(p.courseId)}
    }
    if(action==='import')return this.saveUpload(p)
    if(action==='generate'&&p['kind']==='outline') {
      const scan=await service.handle('scan',{courseId:p.courseId}) as {files:Array<{path:string;status:string;fingerprint:string}>}
      const files=scan.files.filter(f=>f.status==='ready')
      return service.handle('initialize',{courseId:p.courseId,requestId:p['requestId'],paths:files.map(f=>f.path),fingerprints:Object.fromEntries(files.map(f=>[f.path,f.fingerprint]))})
    }
    const result=await service.handle(action,payload)
    if(action==='rename')await this.serialize(async()=>{const project=this.projects.find(v=>v.id===p.courseId)!;project.name=String(p['name']);await atomicJson(join(this.root,'.syllora','projects.json'),this.projects)})
    if(action==='deleteMaterial') {
      await service.settleJobs()
      // 幂等：只有本次真的把一份活跃资料置为删除时才清理产物。重复/陈旧请求
      // （多标签页用旧快照重发）在 SylloraService 里已被守卫挡住、不会再次
      // 删除资料，这里若继续 removeProducts('revisions') 就会把期间重新初始化
      // 产生的已发布 revision 整目录删掉——不可逆产物丢失。
      if(service.takeMaterialDeletion()) {
        const project=this.projects.find(v=>v.id===p.courseId)!
        await removeProducts(project.path,['revisions','.staging'])
      }
    }
    return result
  }
  private async saveUpload(payload:unknown) {
    const p=z.object({courseId:z.string().uuid(),name:z.string().trim().min(1).max(240),text:z.string().max(200000).optional(),base64:z.string().max(28_000_000).optional()}).parse(payload)
    const service=await this.service(p.courseId), state=await service.handle('state',{}) as {courses:Course[];jobs:Array<{id:string;state:string}>}
    if(state.courses[0]?.archived)throw new SylloraError('ARCHIVED','请先恢复归档课程')
    const project=this.projects.find(v=>v.id===p.courseId)!, name=basename(p.name.replaceAll('\\','/'))
    if(!['.pdf','.md','.txt'].includes(extname(name).toLowerCase()))throw new SylloraError('UNSUPPORTED_INPUT','仅支持文本 PDF、MD/TXT')
    const bytes=p.base64?Buffer.from(p.base64,'base64'):Buffer.from(p.text??'','utf8')
    if(bytes.length>SOURCE_LIMIT)throw new SylloraError('LIMIT_EXCEEDED','单文件不能超过 20 MiB')
    const duplicate=(await scanFiles(project.path,state.courses[0]!.materials)).find(f=>f.fingerprint===sha(bytes))
    if(duplicate)return {path:duplicate.path,duplicate:true,pending:true}
    for(const job of state.jobs.filter(j=>j.state==='running'))await service.handle('cancel',{courseId:p.courseId,jobId:job.id})
    const dir=await managedDirectory(project.path,'sources'), ext=extname(name), stem=name.slice(0,-ext.length)
    let chosen=name
    for(let index=1;;index++) {
      try { const file=await open(join(dir,chosen),'wx',0o600);try{await file.writeFile(bytes)}finally{await file.close()};break }
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;chosen=`${stem}-${index}${ext}`}
    }
    return {path:`sources/${chosen}`,pending:true,duplicate:false}
  }
  private async migrate(payload:unknown) {
    const p=z.object({courseId:z.string().uuid(),path:z.string().min(1).optional()}).parse(payload)
    return this.serialize(async()=>{
      const legacy=await jsonFile<StoredCourse>(join(this.root,'syllora.json')), course=legacy?.courses.find(c=>c.id===p.courseId)
      if(!course)throw new SylloraError('NOT_FOUND','旧课程不存在')
      const root=p.path?await realpath(resolve(p.path)):await managedDirectory(await this.managedRoot(),p.courseId), dir=await stateDirectory(root)
      if(await jsonFile(join(dir,'course.json')))throw new SylloraError('COURSE_EXISTS','目标文件夹已有课程，迁移不会覆盖')
      if(this.projects.some(v=>v.id===course.id))throw new SylloraError('COURSE_EXISTS','该旧课程已迁移')
      const copied=structuredClone(course);normalizeCourse(copied)
      for(const material of copied.materials) {
        material.missingOriginal=true;material.warnings=['仅保留旧来源片段，缺少原文件；请补充原始讲义以进行完整初始化。']
        if(material.status==='deleted'||!material.file)continue
        const file=material.file
        if(!z.string().uuid().safeParse(file.id).success||file.ext!=='pdf')throw new SylloraError('STORAGE_ERROR','旧原文件记录不正确，请检查后再迁移')
        let data:Buffer
        try {const path=await within(this.root,`files/${file.id}.pdf`);if((await stat(path)).size>SOURCE_LIMIT)continue;data=await readFile(path)}catch{continue}
        if(data.length>SOURCE_LIMIT||sha(data)!==material.fingerprint)continue
        const sources=await managedDirectory(root,'sources'),name=`legacy-${file.id}.pdf`,target=join(sources,name)
        try {await writeFile(target,data,{flag:'wx',mode:0o600})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||sha(await readFile(await within(root,`sources/${name}`)))!==material.fingerprint)throw new SylloraError('COURSE_EXISTS','迁移原文件的目标已存在或不可写，不会覆盖')}
        material.path=`sources/${name}`;material.missingOriginal=false;material.warnings=['原文件已从旧应用目录复制；已有来源与学习记录保留。']
      }
      const jobs=(legacy?.jobs??[]).filter(job=>typeof job==='object'&&job!==null&&'courseId' in job&&job.courseId===course.id)
      await atomicJson(join(dir,'course.json'),{version:1,courses:[copied],jobs,calls:0,consent:false})
      await this.remember({id:copied.id,path:root,name:copied.name})
      return {id:copied.id,path:root,migrated:true}
    })
  }
}

export async function migrateSharedSettings(root:string,legacyRoots:string[]) {
  const target=await stateDirectory(root)
  if(await stat(join(target,'config.yaml')).catch(()=>null))return
  for(const old of legacyRoots) {
    if(resolve(old)===resolve(root))continue
    const source=join(old,'.syllora')
    if(!(await stat(join(source,'config.yaml')).catch(()=>null))?.isFile())continue
    for(const name of ['credentials.json','config.yaml']) {
      try {await copyFile(join(source,name),join(target,name))} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    }
    return
  }
}
