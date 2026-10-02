"""Verify appearance persistence, the course header menu, and single panel controls."""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get('UI_URL', 'http://127.0.0.1:3001')
SYSTEM_CHROME = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
CHROME = os.environ.get('CHROME_PATH') or (str(SYSTEM_CHROME) if SYSTEM_CHROME.is_file() else None)

def luminance(color):
    values = [float(v) / 255 for v in re.findall(r'[\d.]+', color)[:3]]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values]
    return sum(a * b for a, b in zip(linear, [.2126, .7152, .0722]))

def assert_dark(locator):
    background = locator.evaluate('el => getComputedStyle(el).backgroundColor')
    assert luminance(background) < .12, background

def assert_contrast(locator, background_locator):
    foreground = luminance(locator.evaluate('el => getComputedStyle(el).color'))
    background = luminance(background_locator.evaluate('el => getComputedStyle(el).backgroundColor'))
    contrast = (max(foreground, background) + .05) / (min(foreground, background) + .05)
    assert contrast >= 4.5, contrast

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_load_state('networkidle')

    def settings():
        expect(page.locator('.topbar')).to_be_visible()
        if not page.get_by_role('button', name='用户', exact=True).is_visible():
            page.get_by_role('button', name='打开导航', exact=True).click()
        page.get_by_role('button', name='用户', exact=True).click()
        page.get_by_role('menuitem', name='设置', exact=True).click()
        page.get_by_role('button', name='显示与交互', exact=True).click()

    def course_menu():
        page.locator('.breadcrumbs').get_by_role('button', name=re.compile('课程选项')).click()

    page.get_by_role('button', name='对话学习', exact=True).click()
    expect(page.locator('.topbar-actions button')).to_have_count(2)
    page.get_by_role('button', name='关闭学习面板', exact=True).click()
    assert not page.locator('.task-rail').inner_text().strip()
    expect(page.locator('.task-rail button')).to_have_count(1)
    expect(page.locator('.task-rail svg')).to_have_count(1)
    page.get_by_role('button', name='展开学习面板', exact=True).click()
    page.get_by_role('button', name='辅助阅读', exact=True).click()
    expect(page.locator('.topbar-actions button')).to_have_count(2)
    page.get_by_role('button', name='关闭阅读结果', exact=True).click()
    assert not page.locator('.reader-rail').inner_text().strip()
    expect(page.locator('.reader-rail button')).to_have_count(1)
    expect(page.locator('.reader-rail svg')).to_have_count(1)
    page.get_by_role('button', name='展开阅读助手', exact=True).click()

    # Course dropdown has exactly the requested actions and preserves learning mode.
    course_menu()
    assert page.get_by_role('menu').get_by_role('menuitem').all_text_contents() == ['更换课程', '课程归档', '重命名']
    page.get_by_role('menuitem', name='更换课程', exact=True).click()
    expect(page.get_by_role('dialog', name='更换课程')).to_be_visible()
    page.get_by_role('textbox', name='查找课程', exact=True).fill('概率')
    page.get_by_role('button', name='切换到 概率论与数理统计', exact=True).click()
    expect(page.locator('.breadcrumbs')).to_contain_text('概率论与数理统计')
    expect(page.get_by_role('button', name='辅助阅读', exact=True)).to_have_attribute('aria-pressed', 'true')
    course_menu()
    page.get_by_role('menuitem', name='重命名', exact=True).click()
    page.get_by_role('textbox', name='课程名称', exact=True).fill('概率统计')
    page.get_by_role('button', name='保存名称', exact=True).click()
    expect(page.get_by_role('button', name='课程选项 概率统计', exact=True)).to_be_visible()
    course_menu()
    page.get_by_role('menuitem', name='课程归档', exact=True).click()
    page.get_by_role('button', name='确认归档', exact=True).click()
    expect(page.locator('.breadcrumbs')).to_contain_text('线性代数')
    assert page.locator('.rail-courses').get_by_role('button', name='概率统计', exact=True).count() == 0

    # Legacy compact data has no visual effect; light is the compatible default.
    page.evaluate('''() => {
      const data = JSON.parse(localStorage.getItem('syllora-ui.workspace.v1'));
      data.preferences.compact = true;
      delete data.preferences.theme;
      localStorage.setItem('syllora-ui.workspace.v1', JSON.stringify(data));
    }''')
    page.reload()
    expect(page.locator('.home-content')).to_be_visible()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    assert page.locator('.app-shell.compact').count() == 0
    settings()
    expect(page.get_by_role('radio', name='浅色外观')).to_be_checked()
    assert not page.get_by_role('dialog').get_by_text('紧凑显示', exact=True).count()
    assert not page.get_by_role('dialog').get_by_text('转场与动画', exact=True).count()
    bounds = page.get_by_role('dialog').bounding_box()
    page.get_by_role('radio', name='深色外观').check()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    page.keyboard.press('Escape')
    settings()
    expect(page.get_by_role('radio', name='浅色外观')).to_be_checked()
    page.get_by_role('radio', name='深色外观').check()
    page.get_by_role('button', name='保存外观', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    expect(page.locator('.settings-page-footer')).to_contain_text('外观已更新')
    assert page.get_by_role('dialog').bounding_box()['height'] == bounds['height']
    assert_dark(page.get_by_role('dialog'))
    assert_contrast(page.get_by_role('button', name='保存外观'), page.get_by_role('button', name='保存外观'))
    page.screenshot(path=str(ROOT / 'docs' / 'preview-appearance.png'))
    page.keyboard.press('Escape')
    for locator in [page.locator('.sidebar'), page.locator('.home-course-card').first, page.locator('.home-today'), page.locator('.stats-card').first]:
        assert_dark(locator)
    assert_contrast(page.locator('.home-course-card h3').first, page.locator('.home-course-card').first)
    page.screenshot(path=str(ROOT / 'docs' / 'preview-home-dark.png'))
    page.locator('.home-scroll').evaluate('el => el.scrollTop = el.scrollHeight')
    page.screenshot(path=str(ROOT / 'docs' / 'preview-statistics-dark.png'))
    page.reload()
    expect(page.locator('.home-content')).to_be_visible()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')

    # Dark theme covers document text, dropdowns, dialogs, and menus in body portals.
    page.get_by_role('button', name='辅助阅读', exact=True).click()
    expect(page.locator('.reading-paper')).to_be_visible()
    assert_contrast(page.locator('.reading-paper>p').first, page.locator('.reading-paper'))
    page.get_by_role('combobox', name='选择阅读资料').click()
    assert_dark(page.get_by_role('listbox'))
    page.screenshot(path=str(ROOT / 'docs' / 'preview-reading-dark.png'))
    page.keyboard.press('Escape')
    course_menu()
    assert_dark(page.get_by_role('menu'))
    page.screenshot(path=str(ROOT / 'docs' / 'preview-course-options.png'))
    page.keyboard.press('Escape')
    page.get_by_role('button', name='用户', exact=True).click()
    assert_dark(page.get_by_role('menu', name='用户菜单'))
    page.get_by_role('menuitem', name='帮助', exact=True).hover()
    assert_dark(page.get_by_role('menu', name='帮助菜单'))
    page.keyboard.press('Escape')

    # One reachable opener remains on small screens after removing header controls.
    for width in (1024, 760, 390, 360):
        page.set_viewport_size({'width': width, 'height': 844})
        page.get_by_role('button', name='对话学习', exact=True).click()
        expect(page.get_by_role('button', name='展开学习面板', exact=True)).to_be_visible()
        page.get_by_role('button', name='展开学习面板', exact=True).click()
        expect(page.get_by_role('tab', name='计划', exact=True)).to_be_visible()
        page.get_by_role('button', name='关闭学习面板', exact=True).click()
        page.get_by_role('button', name='辅助阅读', exact=True).click()
        if width > 850:
            page.get_by_role('button', name='关闭阅读结果', exact=True).click()
        page.get_by_role('button', name='展开阅读助手', exact=True).click()
        expect(page.get_by_role('button', name='关闭阅读结果', exact=True)).to_be_visible()
        page.get_by_role('button', name='关闭阅读结果', exact=True).click()
        course_menu()
        menu = page.get_by_role('menu').bounding_box()
        assert menu['x'] >= 0 and menu['x'] + menu['width'] <= width
        page.get_by_role('menuitem', name='更换课程', exact=True).click()
        expect(page.get_by_role('button', name='切换到 线性代数', exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        settings()
        expect(page.get_by_role('radio', name='深色外观')).to_be_checked()
        assert page.locator('.settings-modal').evaluate('el => el.scrollWidth <= el.clientWidth')
        if width == 360:
            page.screenshot(path=str(ROOT / 'docs' / 'preview-appearance-mobile.png'))
        page.keyboard.press('Escape')
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')

    page.set_viewport_size({'width': 1440, 'height': 960})
    settings()
    page.get_by_role('radio', name='浅色外观').check()
    page.get_by_role('button', name='保存外观', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    page.keyboard.press('Escape')
    page.reload()
    expect(page.locator('.home-content')).to_be_visible()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'checks': ['single panel controls', 'clean collapsed rails', 'ordered course header menu', 'course search and change', 'mode preservation', 'header rename and archive', 'legacy preference compatibility', 'appearance preview and cancel', 'dark preference persistence', 'dark cards and text contrast', 'dark portal menus', 'mobile panel access', 'mobile theme picker', 'light restoration', 'no browser exceptions']}, ensure_ascii=True))
    context.close()
    browser.close()
