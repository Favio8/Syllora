"""Check input click boundaries, arrow cursors, and the dark daily target field."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get('UI_URL', 'http://127.0.0.1:3001')
SYSTEM_CHROME = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
CHROME = os.environ.get('CHROME_PATH') or (str(SYSTEM_CHROME) if SYSTEM_CHROME.is_file() else None)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.wait_for_load_state('networkidle')

    def user_action(name):
        page.get_by_role('button', name='用户', exact=True).click()
        page.get_by_role('menuitem', name=name, exact=True).click()

    checked = []

    def boundaries(field, name):
        field.scroll_into_view_if_needed()
        expect(field).to_be_visible()
        rect = field.bounding_box()
        assert field.evaluate('el => getComputedStyle(el).cursor') == 'default', name
        # Click coordinates are the mouse hotspot; the rest of its image has no hit area.
        outside = [(rect['x'] - 2, rect['y'] + rect['height'] / 2),
                   (rect['x'] + rect['width'] + 2, rect['y'] + rect['height'] / 2),
                   (rect['x'] + 12, rect['y'] - 2),
                   (rect['x'] + 12, rect['y'] + rect['height'] + 2)]
        for x, y in outside:
            field.evaluate('el => el.blur()')
            page.mouse.click(x, y)
            assert not field.evaluate('el => el === document.activeElement'), (name, x, y)
        page.mouse.click(rect['x'] + 12, rect['y'] + rect['height'] / 2)
        expect(field).to_be_focused()
        # Tab remains a supported way to focus and edit.
        field.press('Tab')
        page.keyboard.press('Shift+Tab')
        expect(field).to_be_focused()
        checked.append(name)

    user_action('设置')
    page.get_by_role('button', name='显示与交互', exact=True).click()
    page.get_by_role('radio', name='深色外观').check()
    page.get_by_role('button', name='保存外观', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.get_by_role('button', name='用户偏好', exact=True).click()
    boundaries(page.get_by_role('textbox', name='你的称呼', exact=True), '称呼')
    boundaries(page.get_by_role('spinbutton', name='每天留给学习的时间'), '学习时间')
    unit = page.locator('.input-unit')
    assert unit.evaluate('el => getComputedStyle(el).backgroundColor') == 'rgb(19, 28, 43)'
    assert unit.locator('input').evaluate('el => getComputedStyle(el).backgroundColor') == 'rgba(0, 0, 0, 0)'
    assert unit.locator('span').evaluate('el => getComputedStyle(el).whiteSpace') == 'nowrap'
    page.get_by_role('spinbutton').fill('55')
    page.get_by_role('button', name='保存偏好', exact=True).click()
    expect(page.locator('.settings-page-footer')).to_contain_text('学习偏好已保存')
    page.screenshot(path=str(ROOT / 'docs' / 'preview-preferences-dark.png'))
    page.get_by_role('button', name='模型配置', exact=True).click()
    for name in ['接口地址', 'API 密钥', '模型名称']:
        boundaries(page.get_by_role('textbox', name=name, exact=True), name)
    page.keyboard.press('Escape')

    user_action('用户资料')
    boundaries(page.get_by_role('textbox', name='用户名称', exact=True), '用户名称')
    page.keyboard.press('Escape')
    page.get_by_role('button', name='新建课程', exact=True).first.click()
    boundaries(page.get_by_role('textbox', name='课程名称', exact=True), '课程名称')
    page.keyboard.press('Escape')
    page.locator('.rail-nav').get_by_role('button', name='我的课程', exact=True).click()
    boundaries(page.get_by_role('textbox', name='搜索课程或资料'), '搜索')
    page.locator('.rail-courses button').first.click()
    boundaries(page.get_by_role('textbox', name='向 Syllora 提问'), '对话')
    page.locator('.course-options-trigger').click()
    page.get_by_role('menuitem', name='更换课程', exact=True).click()
    boundaries(page.get_by_role('textbox', name='查找课程'), '查找课程')
    page.keyboard.press('Escape')

    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='打开导航', exact=True).click()
    user_action('设置')
    unit = page.locator('.input-unit')
    expect(unit).to_be_visible()
    rect = unit.bounding_box()
    suffix = unit.locator('span').bounding_box()
    assert suffix['x'] + suffix['width'] < rect['x'] + rect['width']
    assert suffix['height'] < 25
    boundaries(page.get_by_role('spinbutton', name='每天留给学习的时间'), '手机学习时间')
    assert not errors, errors
    browser.close()
    print(f'PASS: {len(checked)} fields, click boundaries, keyboard focus, dark background, save, mobile layout, no page errors.')
