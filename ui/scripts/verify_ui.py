"""Browser smoke verification. Requires Python + Playwright and a running UI."""
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
    errors = []
    api_requests = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: api_requests.append(request.url) if '/api/' in request.url else None)
    page.goto(URL)
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='同学，今天想学点什么？')).to_be_visible()
    page.screenshot(path=str(ROOT / 'docs' / 'preview-home.png'), full_page=True)
    assert page.locator('.view-stage').evaluate("el => getComputedStyle(el).animationName") == 'none'
    for course_id, icon in [('linear-algebra', 'math'), ('probability', 'statistics'), ('python', 'code')]:
        assert page.locator(f'.rail-courses [data-course-icon="{icon}"]').count() == 1

    def user_action(name):
        expect(page.locator('.topbar')).to_be_visible()
        if not page.get_by_role('button', name='用户', exact=True).is_visible():
            page.get_by_role('button', name='打开导航', exact=True).click()
        page.get_by_role('button', name='用户', exact=True).click()
        page.get_by_role('menuitem', name=name, exact=True).click()

    # Icon labels appear to the right only on hover/focus.
    assert not page.locator('.icon-rail').inner_text().strip()
    page.get_by_role('button', name='我的课程', exact=True).hover()
    expect(page.get_by_role('tooltip')).to_have_text('我的课程')
    assert page.get_by_role('tooltip').bounding_box()['x'] > page.get_by_role('button', name='我的课程', exact=True).bounding_box()['x']
    page.locator('.topbar').hover()
    expect(page.get_by_role('tooltip')).to_have_count(0)

    # User and nested help menus preserve the requested order.
    page.get_by_role('button', name='用户', exact=True).click()
    assert page.locator('#user-menu > button, #user-menu > .help-menu-item > button').all_text_contents() == ['用户资料', '设置', '帮助', '退出登录']
    page.get_by_role('menuitem', name='帮助', exact=True).hover()
    expect(page.get_by_role('menu', name='帮助菜单')).to_be_visible()
    assert page.locator('.help-submenu button').all_text_contents() == ['用户指南', '协议说明']
    page.screenshot(path=str(ROOT / 'docs' / 'preview-user-menu.png'), full_page=True)
    page.get_by_role('menuitem', name='用户指南', exact=True).click()
    expect(page.get_by_role('dialog', name='用户指南')).to_be_visible()
    page.keyboard.press('Escape')
    user_action('用户资料')
    expect(page.get_by_role('textbox', name='用户名称')).to_have_value('同学')
    page.keyboard.press('Escape')

    # Home entry points, brand return and clickable course breadcrumb.
    page.get_by_role('button', name='把一页资料读明白', exact=False).click()
    expect(page.get_by_role('button', name='辅助阅读', exact=True)).to_have_attribute('aria-pressed', 'true')
    page.get_by_role('button', name='返回主页', exact=True).click()
    expect(page.locator('.home-content')).to_be_visible()
    page.get_by_role('button', name='继续学习', exact=True).click()
    expect(page.get_by_role('textbox', name='向 Syllora 提问')).to_be_visible()
    page.locator('.breadcrumbs').get_by_role('button', name='我的课程', exact=True).click()
    expect(page.locator('.course-card')).to_have_count(3)
    page.get_by_role('button', name='返回主页', exact=True).click()
    page.get_by_role('button', name='继续学习', exact=True).click()
    page.screenshot(path=str(ROOT / 'docs' / 'preview.png'), full_page=True)

    # Task completion and persistence across refresh.
    task_button = page.get_by_role('button', name='标记完成：理解向量的线性相关性', exact=True)
    task_button.click()
    expect(page.get_by_role('button', name='取消完成：理解向量的线性相关性', exact=True)).to_be_visible()
    page.reload()
    expect(page.locator('.home-content')).to_be_visible()
    page.get_by_role('button', name='继续学习', exact=True).click()
    expect(page.get_by_role('button', name='取消完成：理解向量的线性相关性', exact=True)).to_be_visible()

    # Practice modal, radio selection, feedback and Escape restoration.
    page.get_by_role('button', name='开始学习', exact=True).click()
    dialog = page.get_by_role('dialog')
    expect(dialog).to_be_visible()
    dialog.get_by_role('radio').first.check()
    dialog.get_by_role('button', name='查看解释', exact=True).click()
    expect(dialog.get_by_text('回答正确', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)

    # Local mock chat.
    page.get_by_role('textbox', name='向 Syllora 提问').fill('给我一道练习')
    page.get_by_role('button', name='发送消息', exact=True).click()
    expect(page.locator('.message.user')).to_have_count(1)
    expect(page.locator('.message.assistant')).to_have_count(2, timeout=6000)
    expect(page.locator('.message.assistant').last).to_contain_text('已知向量')

    # Course catalog search.
    page.locator('.breadcrumbs').get_by_role('button', name='我的课程', exact=True).click()
    page.get_by_role('textbox', name='搜索课程或资料').fill('Python')
    expect(page.locator('.course-card')).to_have_count(1)
    page.locator('.course-card').click()
    expect(page.locator('.breadcrumbs')).to_contain_text('Python 程序设计')

    # A created course starts empty, rather than inheriting mock knowledge.
    page.get_by_role('button', name='新建课程', exact=True).first.click()
    page.get_by_role('textbox', name='课程名称').fill('测试课程')
    expect(page.get_by_role('button', name='创建课程', exact=True)).to_be_disabled()
    page.get_by_role('radio', name='化学', exact=True).check()
    expect(page.locator('.course-identity-preview [data-course-icon="science"]')).to_be_visible()
    page.screenshot(path=str(ROOT / 'docs' / 'preview-course-icons.png'), full_page=True)
    page.get_by_role('button', name='创建课程', exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(page.locator('.breadcrumbs')).to_contain_text('测试课程')
    expect(page.locator('.chat-empty')).to_be_visible()
    expect(page.get_by_role('button', name='测试课程', exact=True).locator('[data-course-icon="science"]')).to_be_visible()

    # File metadata only: no upload request should be issued.
    with page.expect_file_chooser() as chooser:
        page.get_by_role('button', name='添加你的学习资料', exact=False).click()
    chooser.value.set_files({'name': '演示资料.txt', 'mimeType': 'text/plain', 'buffer': b'UI verification'})
    expect(page.locator('.panel-file')).to_have_count(1)
    page.get_by_role('button', name='资料库', exact=True).click()
    page.get_by_role('textbox', name='搜索课程或资料').fill('演示资料')
    expect(page.locator('.material-row')).to_have_count(1)
    page.get_by_role('button', name='移除资料 演示资料.txt', exact=True).click()
    page.get_by_role('button', name='确认移除', exact=True).click()
    expect(page.locator('.material-row')).to_have_count(0)

    # Preferences and course metadata survive a browser refresh.
    user_action('设置')
    page.get_by_role('textbox', name='你的称呼').fill('小林')
    page.get_by_role('spinbutton', name='每天留给学习的时间').fill('55')
    page.get_by_role('button', name='保存偏好', exact=True).click()
    page.reload()
    expect(page.get_by_role('heading', name='小林，今天想学点什么？')).to_be_visible()
    expect(page.get_by_role('button', name='测试课程', exact=True).locator('[data-course-icon="science"]')).to_be_visible()
    page.get_by_role('button', name='查看全部', exact=True).click()
    expect(page.locator('.course-card').filter(has_text='测试课程').locator('[data-course-icon="science"]')).to_be_visible()
    page.get_by_role('button', name='学习工作台', exact=True).click()
    user_action('用户资料')
    expect(page.get_by_role('textbox', name='用户名称')).to_have_value('小林')
    page.keyboard.press('Escape')
    page.get_by_role('button', name='课程选项 线性代数', exact=True).click()
    page.get_by_role('menuitem', name='重命名', exact=True).click()
    page.get_by_role('textbox', name='课程名称').fill('线性代数 · 演示')
    page.get_by_role('button', name='保存名称', exact=True).click()
    expect(page.locator('.breadcrumbs')).to_contain_text('线性代数 · 演示')

    # Restore the preview baseline after mutations.
    user_action('设置')
    page.get_by_role('button', name='数据管理', exact=True).click()
    page.get_by_role('button', name='恢复初始演示数据', exact=True).click()
    page.get_by_role('button', name='确认恢复', exact=True).click()
    expect(page.locator('.breadcrumbs')).to_contain_text('线性代数')
    expect(page.locator('.workspace-intro')).to_contain_text('同学，欢迎回到你的学习空间。')
    expect(page.locator('.toast')).to_have_count(0, timeout=5000)

    # Tablet and mobile layouts, including drawers and catalog screens.
    for width in (1024, 760, 390, 360):
        page.set_viewport_size({'width': width, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'overflow at {width}'
        expect(page.get_by_role('button', name='发送消息', exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(ROOT / 'docs' / 'preview-mobile.png'), full_page=True)
    page.get_by_role('button', name='展开学习面板', exact=True).click()
    expect(page.get_by_role('tab', name='计划', exact=True)).to_be_visible()
    page.get_by_role('tab', name='大纲', exact=True).click()
    expect(page.get_by_role('heading', name='知识地图', exact=True)).to_be_visible()
    page.get_by_role('button', name='关闭学习面板', exact=True).click()
    page.get_by_role('button', name='打开导航', exact=True).click()
    page.locator('.rail-nav').get_by_role('button', name='我的课程', exact=True).click()
    expect(page.locator('.course-card')).to_have_count(3)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.get_by_role('button', name='打开导航', exact=True).click()
    page.get_by_role('button', name='复习与巩固', exact=True).click()
    expect(page.locator('.review-detail-card')).to_have_count(3)
    page.locator('.review-detail-card').first.get_by_role('button', name='开始巩固').click()
    expect(page.get_by_role('dialog')).to_be_visible()
    page.keyboard.press('Escape')

    # Home and course icon picker fit small screens too.
    page.get_by_role('button', name='打开导航', exact=True).click()
    page.get_by_role('button', name='返回主页', exact=True).click()
    for width in (760, 390, 360):
        page.set_viewport_size({'width': width, 'height': 844})
        expect(page.locator('.home-content')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'home overflow at {width}'
    page.screenshot(path=str(ROOT / 'docs' / 'preview-home-mobile.png'), full_page=True)
    page.locator('.topbar').get_by_role('button', name='新建课程', exact=True).click()
    expect(page.get_by_role('radio')).to_have_count(12)
    assert page.get_by_role('dialog').bounding_box()['width'] <= 360
    page.get_by_role('radio', name='音乐', exact=True).check()
    page.keyboard.press('Escape')

    # Reading, native selection toolbar and local explanation/search.
    page.set_viewport_size({'width': 1440, 'height': 960})
    page.get_by_role('button', name='学习工作台', exact=True).click()
    page.get_by_role('button', name='辅助阅读', exact=True).click()
    expect(page.get_by_role('button', name='辅助阅读', exact=True)).to_have_attribute('aria-pressed', 'true')
    expect(page.get_by_role('article', name='资料正文')).to_contain_text('线性相关')

    def select_reading_text():
        coordinates = page.locator('.reading-paper > p').first.evaluate('''el => {
          const text = el.firstChild;
          const first = document.createRange();
          first.setStart(text, 0); first.setEnd(text, 1);
          const last = document.createRange();
          last.setStart(text, text.length - 1); last.setEnd(text, text.length);
          const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
          return { sx: a.left + 1, sy: a.top + a.height / 2, ex: b.right - 1, ey: b.top + b.height / 2 };
        }''')
        # Collapse a previous native selection before starting a new drag.
        page.mouse.click(coordinates['sx'], coordinates['sy'])
        page.mouse.move(coordinates['sx'], coordinates['sy'])
        page.mouse.down()
        page.mouse.move(coordinates['ex'], coordinates['ey'], steps=18)
        page.mouse.up()
        expect(page.get_by_role('toolbar', name='选中文字操作')).to_be_visible()

    select_reading_text()
    page.screenshot(path=str(ROOT / 'docs' / 'preview-reading-selection.png'), full_page=True)
    page.get_by_role('button', name='AI解释', exact=True).click()
    expect(page.locator('.reading-explanation')).to_contain_text('独立方向', timeout=5000)
    expect(page.locator('.reading-quote')).to_contain_text('理解一个空间')
    expect(page.get_by_role('toolbar', name='选中文字操作')).to_have_count(0)
    select_reading_text()
    page.get_by_role('button', name='AI搜索', exact=True).click()
    expect(page.locator('.reading-search-results article')).to_have_count(3)
    page.get_by_role('combobox', name='选择阅读资料').click()
    page.get_by_role('option', name='课堂笔记 — 向量空间.md', exact=False).click()
    expect(page.locator('.reading-paper')).to_contain_text('课堂笔记')
    expect(page.locator('.reading-search-results')).to_have_count(0)

    # Imported text is displayed literally, without executing markup.
    with page.expect_file_chooser() as chooser:
        page.locator('.reader-toolbar').get_by_role('button', name='添加资料', exact=True).click()
    chooser.value.set_files({'name': '阅读测试.md', 'mimeType': 'text/markdown', 'buffer': '# 本地阅读测试\n\n这是一段本地文本。\n\n<script>alert(1)</script>'.encode('utf-8')})
    page.get_by_role('combobox', name='选择阅读资料').click()
    expect(page.get_by_role('option')).to_have_count(4)
    page.get_by_role('option', name='阅读测试.md', exact=False).click()
    expect(page.locator('.reading-paper')).to_contain_text('这是一段本地文本。')
    expect(page.locator('.reading-paper')).to_contain_text('<script>alert(1)</script>')
    assert page.locator('.reading-paper script').count() == 0
    page.get_by_role('button', name='对话学习', exact=True).click()
    expect(page.get_by_role('textbox', name='向 Syllora 提问')).to_be_visible()

    # Mobile reading and user/help menus fit on screen.
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='辅助阅读', exact=True).click()
    expect(page.locator('.reading-paper')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    select_reading_text()
    page.get_by_role('button', name='AI解释', exact=True).click()
    expect(page.locator('.reader-assistant.has-answer')).to_be_visible()
    expect(page.locator('.reading-explanation')).to_be_visible()
    expect(page.locator('.toast')).to_have_count(0, timeout=5000)
    page.screenshot(path=str(ROOT / 'docs' / 'preview-reading-mobile.png'), full_page=True)
    page.get_by_role('button', name='关闭阅读结果', exact=True).click()
    page.get_by_role('button', name='打开导航', exact=True).click()
    page.get_by_role('button', name='用户', exact=True).click()
    page.get_by_role('menuitem', name='帮助', exact=True).click()
    expect(page.get_by_role('menu', name='帮助菜单')).to_be_visible()
    bounds = page.get_by_role('menu', name='帮助菜单').bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390
    page.get_by_role('menuitem', name='协议说明', exact=True).click()
    expect(page.get_by_role('dialog', name='协议说明')).to_be_visible()
    page.keyboard.press('Escape')
    user_action('退出登录')
    expect(page.get_by_role('heading', name='已退出学习空间')).to_be_visible()
    page.reload()
    expect(page.get_by_role('heading', name='已退出学习空间')).to_be_visible()
    page.get_by_role('button', name='进入学习空间', exact=False).click()
    expect(page.locator('.home-content')).to_be_visible()

    # Normal motion remains operable; reduced motion skips transitions.
    page.set_viewport_size({'width': 1440, 'height': 960})
    page.emulate_media(reduced_motion='no-preference')
    page.get_by_role('button', name='继续学习', exact=True).click()
    assert page.locator('.view-stage').evaluate("el => getComputedStyle(el).animationName") != 'none'
    page.get_by_role('button', name='新建课程', exact=True).first.click()
    expect(page.get_by_role('dialog')).to_be_visible()
    assert page.get_by_role('dialog').evaluate("el => getComputedStyle(el).animationName") != 'none'
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    page.emulate_media(reduced_motion='reduce')
    page.get_by_role('button', name='返回主页', exact=True).click()
    assert page.locator('.view-stage').evaluate("el => getComputedStyle(el).animationName") == 'none'

    assert not errors, errors
    assert not api_requests, api_requests
    print(json.dumps({'result': 'passed', 'checks': ['home default and refresh', 'home learning entries', 'brand return', 'clickable course breadcrumb', 'legacy icon fallback', 'required icon selection', 'icon persistence and consistency', 'home mobile layout', 'mobile icon picker', 'motion and reduced motion', 'icon hover labels', 'user menu order', 'nested help menus', 'task persistence', 'practice feedback', 'mock chat', 'catalog search', 'empty course creation', 'file metadata', 'material removal', 'preferences', 'rename', 'reset', 'responsive layouts', 'mobile drawers', 'review modal', 'reading mode switch', 'selection toolbar', 'AI explanation', 'AI search', 'document switching', 'local text rendering', 'mobile reading', 'logout persistence', 'no business API requests', 'no browser exceptions']}, ensure_ascii=True))
    context.close()
    browser.close()
