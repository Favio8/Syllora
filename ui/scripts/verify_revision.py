"""Interaction verification for the dashboard, course management, and settings revision."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get('UI_URL', 'http://127.0.0.1:3001')
SYSTEM_CHROME = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
CHROME = os.environ.get('CHROME_PATH') or (str(SYSTEM_CHROME) if SYSTEM_CHROME.is_file() else None)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    page = context.new_page()
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: requests.append(r.url) if '/api/' in r.url or 'your-api.example' in r.url else None)
    page.goto(URL)
    page.wait_for_load_state('networkidle')

    def data():
        return page.evaluate("JSON.parse(localStorage.getItem('syllora-ui.workspace.v1'))")

    def mode_position():
        return page.get_by_role('group', name='学习模式', exact=True).bounding_box()

    def same_position(before):
        after = mode_position()
        assert abs(before['x'] - after['x']) < 1 and abs(before['y'] - after['y']) < 1, (before, after)

    def settings():
        expect(page.locator('.topbar')).to_be_visible()
        if not page.get_by_role('button', name='用户', exact=True).is_visible():
            page.get_by_role('button', name='打开导航', exact=True).click()
        page.get_by_role('button', name='用户', exact=True).click()
        page.get_by_role('menuitem', name='设置', exact=True).click()
        expect(page.get_by_role('dialog', name='设置', exact=True)).to_be_visible()

    def catalog():
        if page.locator('.breadcrumbs').get_by_role('button', name='我的课程', exact=True).count():
            page.locator('.breadcrumbs').get_by_role('button', name='我的课程', exact=True).click()
        else:
            page.get_by_role('button', name='查看全部', exact=True).click()

    def manage(name, action):
        page.get_by_role('button', name=f'管理课程 {name}', exact=True).click()
        page.get_by_role('menuitem', name=action, exact=True).click()

    # Real records can be separated from clearly tagged example history.
    expect(page.locator('.heatmap-cell')).to_have_count(84)
    page.get_by_role('button', name='展示演示记录', exact=True).click()
    expect(page.locator('.stats-summary strong').first).to_have_text('0天')
    page.get_by_role('button', name='30 天', exact=True).click()
    expect(page.locator('.stats-trend svg')).to_have_attribute('aria-label', '近 30 天活动建议时长趋势，总计 0 分钟')
    page.locator('.heatmap-cell').first.click()
    expect(page.locator('.heatmap-footer')).to_contain_text('0 次活动')
    initial_position = mode_position()

    # Practice and attachments live below the form, and practice updates statistics.
    page.get_by_role('button', name='对话学习', exact=True).click()
    same_position(initial_position)
    composer = page.locator('form.composer').bounding_box()
    for name in ('练习', '添加资料'):
        bounds = page.locator('.composer-actions').get_by_role('button', name=name, exact=True).bounding_box()
        assert bounds['y'] >= composer['y'] + composer['height']
    assert page.locator('form.composer').get_by_role('button', name='添加资料', exact=True).count() == 0
    page.get_by_role('button', name='练习', exact=True).click()
    dialog = page.get_by_role('dialog', name='巩固一下', exact=True)
    expect(dialog.get_by_role('button', name='完成本次活动', exact=False)).to_be_disabled()
    dialog.get_by_role('radio').first.check()
    dialog.get_by_role('button', name='查看解释', exact=True).click()
    expect(dialog.get_by_text('回答正确', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='完成本次活动', exact=False).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    assert len([r for r in data()['activity'] if not r.get('demo') and r['kind'] == 'practice']) == 1
    page.get_by_role('textbox', name='向 Syllora 提问').fill('解释线性相关')
    page.get_by_role('button', name='发送消息', exact=True).click()
    expect(page.locator('.message.assistant')).to_have_count(2, timeout=5000)
    page.get_by_role('button', name='标记完成：理解向量的线性相关性', exact=True).click()
    assert len([r for r in data()['activity'] if r.get('taskId') == 'l-2']) == 1
    page.get_by_role('button', name='取消完成：理解向量的线性相关性', exact=True).click()
    assert len([r for r in data()['activity'] if r.get('taskId') == 'l-2']) == 0
    page.get_by_role('button', name='返回主页', exact=True).click()
    page.get_by_role('button', name='展示演示记录', exact=True).click()
    expect(page.locator('.stats-summary strong').nth(1)).to_have_text('10分钟')
    expect(page.locator('.stats-summary strong').nth(2)).to_have_text('1次')
    page.reload()
    expect(page.locator('.home-content')).to_be_visible()
    assert len([r for r in data()['activity'] if not r.get('demo')]) == 2

    # Desktop task panel and idle reading assistant collapse; controls remain fixed.
    page.get_by_role('button', name='对话学习', exact=True).click()
    page.get_by_role('button', name='关闭学习面板', exact=True).click()
    expect(page.get_by_role('complementary', name='任务看板已收起')).to_be_visible()
    same_position(initial_position)
    page.get_by_role('button', name='展开学习面板', exact=True).click()
    expect(page.get_by_role('tab', name='计划', exact=True)).to_be_visible()
    page.get_by_role('button', name='关闭学习面板', exact=True).click()
    expect(page.locator('.study-panel')).to_have_count(0)
    page.get_by_role('button', name='展开学习面板', exact=True).click()
    page.get_by_role('button', name='辅助阅读', exact=True).click()
    same_position(initial_position)
    idle_close = page.get_by_role('button', name='关闭阅读结果', exact=True).bounding_box()
    page.get_by_role('button', name='关闭阅读结果', exact=True).click()
    expect(page.get_by_role('complementary', name='阅读助手', exact=True)).to_have_count(0)
    expand = page.get_by_role('button', name='展开阅读助手', exact=True).bounding_box()
    assert abs(expand['x'] - idle_close['x']) < 1 and abs(expand['y'] - idle_close['y']) < 1
    page.get_by_role('button', name='展开阅读助手', exact=True).click()
    expect(page.get_by_role('heading', name='从一个疑问开始')).to_be_visible()
    same_position(initial_position)

    # Every former native select uses the same list, with mouse/keyboard dismissal.
    page.emulate_media(reduced_motion='no-preference')
    dropdown = page.get_by_role('combobox', name='选择阅读资料')
    dropdown.click()
    expect(page.get_by_role('listbox')).to_be_visible()
    assert page.get_by_role('listbox').evaluate("el => getComputedStyle(el).borderRadius") == '12px'
    assert page.get_by_role('listbox').evaluate("el => getComputedStyle(el).animationName") != 'none'
    page.keyboard.press('ArrowDown')
    page.keyboard.press('Enter')
    expect(dropdown).to_contain_text('课堂笔记')
    expect(page.locator('.reading-paper')).to_contain_text('课堂笔记')
    dropdown.click()
    page.keyboard.press('Escape')
    expect(page.get_by_role('listbox')).to_have_count(0)
    page.emulate_media(reduced_motion='reduce')

    # Settings retain one fixed size; API key stays out of durable workspace data.
    settings()
    settings_bounds = page.get_by_role('dialog', name='设置', exact=True).bounding_box()
    assert settings_bounds['width'] == 860 and settings_bounds['height'] == 620
    for name in ('模型配置', '显示与交互', '数据管理', '用户偏好'):
        page.get_by_role('button', name=name, exact=True).click()
        bounds = page.get_by_role('dialog', name='设置', exact=True).bounding_box()
        assert bounds['width'] == settings_bounds['width'] and bounds['height'] == settings_bounds['height']
    page.get_by_role('button', name='模型配置', exact=True).click()
    page.get_by_role('button', name='检查配置格式', exact=True).click()
    expect(page.locator('.settings-page-footer')).to_contain_text('请填写有效')
    page.get_by_role('textbox', name='接口地址', exact=True).fill('https://your-api.example/v1')
    page.get_by_role('textbox', name='模型名称', exact=True).fill('demo-model')
    page.get_by_label('API 密钥', exact=True).fill('demo-session-token')
    page.get_by_role('button', name='显示 API 密钥', exact=True).click()
    expect(page.get_by_label('API 密钥', exact=True)).to_have_attribute('type', 'text')
    page.get_by_role('button', name='隐藏 API 密钥', exact=True).click()
    page.get_by_role('combobox', name='接口格式', exact=True).click()
    expect(page.get_by_role('listbox')).to_be_visible()
    assert page.get_by_role('listbox').evaluate("el => el.closest('dialog') !== null")
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog', name='设置', exact=True)).to_be_visible()
    page.get_by_role('combobox', name='接口格式', exact=True).click()
    page.get_by_role('option', name='原生接口', exact=False).click()
    page.get_by_role('button', name='保存配置', exact=True).click()
    expect(page.locator('.settings-page-footer')).to_contain_text('配置已保存')
    assert data()['apiConfig']['format'] == 'native'
    assert page.evaluate("sessionStorage.getItem('syllora-ui.api-key') === 'demo-session-token'")
    assert page.evaluate("!localStorage.getItem('syllora-ui.workspace.v1').includes('demo-session-token')")
    page.get_by_role('button', name='用户偏好', exact=True).click()
    page.get_by_role('textbox', name='你的称呼', exact=True).fill('阿宁')
    page.get_by_role('button', name='保存偏好', exact=True).click()
    expect(page.locator('.settings-page-footer')).to_contain_text('学习偏好已保存')
    page.keyboard.press('Escape')
    page.reload()
    settings()
    page.get_by_role('button', name='模型配置', exact=True).click()
    expect(page.get_by_role('textbox', name='模型名称', exact=True)).to_have_value('demo-model')
    expect(page.get_by_label('API 密钥', exact=True)).to_have_value('demo-session-token')
    page.screenshot(path=str(ROOT / 'docs' / 'preview-settings.png'))
    page.keyboard.press('Escape')

    # Archive hides active courses; restore retains every material and message.
    catalog()
    before = next(c for c in data()['courses'] if c['id'] == 'probability')
    manage('概率论与数理统计', '归档课程')
    expect(page.get_by_role('dialog', name='归档课程')).to_be_visible()
    page.get_by_role('button', name='取消', exact=True).click()
    expect(page.locator('.course-card')).to_have_count(3)
    manage('概率论与数理统计', '归档课程')
    page.get_by_role('button', name='确认归档', exact=True).click()
    expect(page.locator('.course-card')).to_have_count(2)
    assert page.locator('.rail-courses').get_by_role('button', name='概率论与数理统计', exact=True).count() == 0
    page.get_by_role('button', name='已归档', exact=False).click()
    expect(page.locator('.course-card')).to_have_count(1)
    manage('概率论与数理统计', '重命名')
    page.get_by_role('textbox', name='课程名称', exact=True).fill('概率统计 · 已整理')
    page.get_by_role('button', name='保存名称', exact=True).click()
    manage('概率统计 · 已整理', '恢复课程')
    expect(page.locator('.course-card')).to_have_count(0)
    after = next(c for c in data()['courses'] if c['id'] == 'probability')
    assert after['materials'] == before['materials'] and after['messages'] == before['messages'] and after['tasks'] == before['tasks']
    page.get_by_role('button', name='正在学习', exact=False).click()
    expect(page.locator('.course-card')).to_have_count(3)
    page.get_by_role('button', name='管理课程 概率统计 · 已整理', exact=True).click()
    page.screenshot(path=str(ROOT / 'docs' / 'preview-course-management.png'))
    page.keyboard.press('Escape')
    same_position(initial_position)

    # Delete asks for confirmation and removes only the selected course and records.
    manage('Python 程序设计', '删除课程')
    page.get_by_role('button', name='取消', exact=True).click()
    expect(page.locator('.course-card')).to_have_count(3)
    manage('Python 程序设计', '删除课程')
    page.get_by_role('button', name='确认删除课程', exact=True).click()
    expect(page.locator('.course-card')).to_have_count(2)
    assert not any(c['id'] == 'python' for c in data()['courses'])
    assert not any(r['courseId'] == 'python' for r in data()['activity'])
    page.reload()
    assert len(data()['courses']) == 2
    catalog()
    page.get_by_role('button', name='资料库', exact=True).click()
    page.get_by_role('combobox', name='按课程筛选资料').click()
    page.get_by_role('option', name='概率统计 · 已整理', exact=True).click()
    expect(page.locator('.material-row')).to_have_count(1)
    assert page.locator('select').count() == 0

    # Mobile settings and both panel toggles remain reachable without overflow.
    for width in (760, 390, 360):
        page.set_viewport_size({'width': width, 'height': 844})
        page.get_by_role('button', name='对话学习', exact=True).click()
        pos = mode_position()
        expect(page.locator('.composer-actions').get_by_role('button', name='练习')).to_be_visible()
        page.get_by_role('button', name='展开学习面板', exact=True).click()
        expect(page.get_by_role('tab', name='计划', exact=True)).to_be_visible()
        page.get_by_role('button', name='关闭学习面板', exact=True).click()
        page.get_by_role('button', name='辅助阅读', exact=True).click()
        same_position(pos)
        page.get_by_role('button', name='展开阅读助手', exact=True).click()
        expect(page.get_by_role('button', name='关闭阅读结果', exact=True)).to_be_visible()
        page.get_by_role('button', name='关闭阅读结果', exact=True).click()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        settings()
        for name in ('模型配置', '用户偏好', '数据管理', '显示与交互'):
            page.get_by_role('button', name=name, exact=True).click()
            bounds = page.get_by_role('dialog', name='设置', exact=True).bounding_box()
            assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width and bounds['height'] == 620
            assert page.locator('.settings-modal').evaluate('el => el.scrollWidth <= el.clientWidth')
        if width == 360:
            page.screenshot(path=str(ROOT / 'docs' / 'preview-settings-mobile.png'))
        page.keyboard.press('Escape')
    page.get_by_role('button', name='打开导航', exact=True).click()
    page.get_by_role('button', name='返回主页', exact=True).click()
    page.locator('.home-scroll').evaluate('el => el.scrollTop = el.scrollHeight')
    page.screenshot(path=str(ROOT / 'docs' / 'preview-statistics-mobile.png'))
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')

    # An empty active workspace (all archived) can still create or restore courses.
    page.set_viewport_size({'width': 1440, 'height': 960})
    catalog()
    for name in ('线性代数', '概率统计 · 已整理'):
        manage(name, '归档课程')
        page.get_by_role('button', name='确认归档', exact=True).click()
    page.get_by_role('button', name='返回主页', exact=True).click()
    expect(page.get_by_role('button', name='对话学习', exact=True)).to_be_disabled()
    page.get_by_role('button', name='创建第一门课程', exact=True).click()
    page.get_by_role('textbox', name='课程名称', exact=True).fill('新学习空间')
    page.get_by_role('radio', name='文学', exact=True).check()
    page.get_by_role('button', name='创建课程', exact=True).click()
    expect(page.get_by_role('textbox', name='向 Syllora 提问')).to_be_visible()
    page.get_by_role('button', name='练习', exact=True).click()
    expect(page.get_by_role('dialog')).to_contain_text('阅读一段资料后')
    page.keyboard.press('Escape')

    assert not errors, errors
    assert not requests, requests
    print(json.dumps({'result': 'passed', 'checks': ['statistics and demo toggle', 'activity recording and persistence', 'practice and upload below composer', 'practice feedback', 'task collapse and restore', 'idle reader collapse at same position', 'stable mode controls', 'rounded animated selects', 'keyboard select and dismiss', 'fixed settings dimensions', 'API format validation', 'API persistence', 'session-only key', 'modal dropdown focus', 'preferences', 'archive and restore preservation', 'archived course rename', 'delete confirmation and persistence', 'material course selector', 'mobile panels', 'mobile fixed settings', 'mobile statistics', 'all archived empty state', 'new course practice', 'no API calls or browser errors']}, ensure_ascii=True))
    context.close()
    browser.close()
