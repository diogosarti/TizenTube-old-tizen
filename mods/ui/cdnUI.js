import { t } from 'i18next';

let screen, previousFocus, backAction;

function close() {
    if (!screen) return;
    screen.parentNode.removeChild(screen);
    screen = null;
    ['keydown', 'keypress', 'keyup'].forEach(type => window.removeEventListener(type, key, true));
    if (previousFocus && document.documentElement.contains(previousFocus)) previousFocus.focus();
}

function key(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'keydown') return;
    if ([8, 27, 461, 10009].includes(event.keyCode)) return backAction();
    const buttons = Array.from(screen.querySelectorAll('button'));
    const index = buttons.indexOf(document.activeElement);
    if (event.keyCode === 13 && index >= 0) buttons[index].click();
    else if ([37, 38, 39, 40].includes(event.keyCode)) {
        const next = Math.max(0, Math.min(buttons.length - 1, index + ([37, 38].includes(event.keyCode) ? -1 : 1)));
        buttons[next].focus();
    }
}

function render(title, subtitle, items, back = close) {
    if (!screen) {
        previousFocus = document.activeElement;
        screen = document.createElement('div');
        screen.id = 'tt-cdn-journal';
        screen.setAttribute('role', 'dialog'); screen.setAttribute('aria-modal', 'true');
        screen.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:36px 52px;background:#101010;color:#fff;z-index:2147483647;display:-webkit-flex;display:flex;-webkit-flex-direction:column;flex-direction:column;font-family:Arial,sans-serif;';
        document.body.appendChild(screen);
        ['keydown', 'keypress', 'keyup'].forEach(type => window.addEventListener(type, key, true));
    }
    backAction = back;
    screen.textContent = '';
    const style = document.createElement('style');
    style.textContent = '#tt-cdn-journal button{display:block;width:100%;box-sizing:border-box;white-space:normal;word-wrap:break-word;word-break:break-all;text-align:left;font:28px Arial,sans-serif;color:#fff;background:#262626;border:3px solid transparent;padding:14px 18px;margin:8px 0;}#tt-cdn-journal button:focus{outline:none;border-color:#fff;background:#444;}';
    screen.appendChild(style);
    const heading = document.createElement('h1');
    heading.textContent = title;
    heading.style.cssText = 'font-size:36px;margin:0 0 12px;word-wrap:break-word;word-break:break-all;-webkit-flex-shrink:0;flex-shrink:0;';
    screen.appendChild(heading);
    const info = document.createElement('p');
    info.textContent = subtitle;
    info.style.cssText = 'font-size:24px;white-space:pre-wrap;margin:0 0 16px;-webkit-flex-shrink:0;flex-shrink:0;';
    screen.appendChild(info);
    const list = document.createElement('div');
    list.style.cssText = 'overflow-y:auto;min-height:0;-webkit-flex:1;flex:1;position:relative;';
    screen.appendChild(list);
    items.forEach(item => {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = item.title;
        button.onclick = item.action;
        button.onfocus = () => {
            if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop;
            else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight)
                list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight;
        };
        list.appendChild(button);
    });
    list.querySelector('button').focus();
}

export function showCDNs() {
    const transport = parent.__legacyTLS, journal = transport.problemCDNs;
    const rows = journal.read();
    let subtitle = t('cdnJournal.header', { count: rows.length }) + ' · ' +
        t(transport.summary().cdnCollecting ? 'cdnJournal.enabled' : 'cdnJournal.disabled');
    if (!journal.summary().persistent) subtitle += '\n' + t('cdnJournal.storageError');
    if (!rows.length) subtitle += '\n' + t('cdnJournal.empty');
    const items = rows.map(row => ({ title: row.host, action: () => cdnAction('CDN_ENTRY', { host: row.host }) }));
    if (rows.length) items.push({ title: t('cdnJournal.clear'), action: () => cdnAction('CDN_CLEAR_CONFIRM') });
    items.push({ title: t('cdnJournal.close'), action: close });
    render(t('cdnJournal.title'), subtitle, items);
}

export function cdnAction(action, parameters = {}) {
    const journal = parent.__legacyTLS.problemCDNs;
    if (action === 'CDN_SHOW') return showCDNs();
    if (action === 'CDN_CLEAR_CONFIRM') return render(t('cdnJournal.clearQuestion'), '', [
        { title: t('cdnJournal.cancel'), action: showCDNs },
        { title: t('cdnJournal.clear'), action: () => cdnAction('CDN_CLEAR') }
    ], showCDNs);
    if (action === 'CDN_CLEAR') { journal.clear(); return showCDNs(); }
    if (action === 'CDN_DELETE') { journal.remove(parameters.host); return showCDNs(); }
    const row = journal.read().filter(entry => entry.host === parameters.host)[0];
    if (!row) return showCDNs();
    render(row.host, t('cdnJournal.details', { count: row.count, mode: row.mode, reason: t('cdnJournal.reasons.' + row.reason),
        first: new Date(row.firstAt).toLocaleString(), last: new Date(row.lastAt).toLocaleString() }), [
        { title: t('cdnJournal.remove'), action: () => cdnAction('CDN_DELETE', { host: row.host }) },
        { title: t('cdnJournal.back'), action: showCDNs }
    ], showCDNs);
}
