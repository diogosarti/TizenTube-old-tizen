'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');
const JSZip = require('jszip');
const pkg = require('./package.json');

function checkLegacySyntax(source, name) {
    const ast = acorn.parse(source, { ecmaVersion: 5, allowReserved: true });
    const bodies = new Set();
    function visit(node, parent) {
        if (!node || !node.type) return;
        if (/Function/.test(node.type)) bodies.add(node.body);
        if (node.type === 'FunctionDeclaration' && parent.type !== 'Program' && !bodies.has(parent)) {
            throw new Error('WebKit rejects nested function declarations in ' + name);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(child => visit(child, node));
            else if (value && value.type) visit(value, node);
        }
    }
    visit(ast, null);
}

async function build() {
    const config = fs.readFileSync(path.join(__dirname, 'widget/config.xml'), 'utf8');
    if (!config.includes('version="' + pkg.version + '"')) throw new Error('Widget and package versions differ');
    const rollup = path.resolve(__dirname, '../mods/node_modules/rollup/dist/bin/rollup');
    const result = spawnSync(process.execPath, [rollup, '-c', 'rollup.legacy.config.js'], { cwd: path.resolve(__dirname, '../mods'), stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Legacy bundle build failed');
    const files = {
        'config.xml': 'widget/config.xml', 'index.html': 'widget/index.html', 'widget.js': 'widget/widget.js', 'player.html': 'widget/player.html',
        'logger.js': 'web/logger.js', 'frame.js': 'web/frame.js', 'player.css': 'widget/player.css',
        'tls-transport.js': 'web/tls-transport.js', 'tls-client.nmf': 'native/assets/tls-client.nmf', 'tls-client.nexe': 'native/assets/tls-client.nexe',
        'LICENSE-MbedTLS.txt': 'native/assets/LICENSE-MbedTLS.txt', 'NOTICE-NaCl.txt': 'native/assets/NOTICE-NaCl.txt',
        'LICENSE-CA.txt': 'native/assets/LICENSE-CA.txt',
        'LICENSE-zlib.txt': 'native/assets/LICENSE-zlib.txt',
        'ca-roots.pem': 'native/assets/ca-roots.pem',
        'compat.js': 'dist/direct-compat.js', 'userScript.js': 'dist/userScript.js',
        'icon-launcher.png': 'widget/icon.png', 'LICENSE': '../LICENSE'
    };
    const stage = path.join(__dirname, 'dist/widget-' + pkg.version);
    const zip = new JSZip();
    if (fs.existsSync(stage)) {
        const expected = new Set([...Object.keys(files), 'THIRD_PARTY_NOTICES.txt']);
        if (fs.readdirSync(stage).some(name => !expected.has(name))) throw new Error('Stage contains unexpected files; use a new version or a clean stage');
    }
    const notices = [
        ['core-js', 'LICENSE'], ['whatwg-fetch', 'LICENSE'], ['i18next', 'LICENSE'],
        ['@babel/runtime', 'LICENSE'], ['esprima', 'LICENSE.BSD'], ['estraverse', 'LICENSE.BSD'], ['qrcode-npm', 'LICENSE']
    ].map(([name, file]) => name + '\n\n' + fs.readFileSync(path.resolve(__dirname, '../mods/node_modules', name, file), 'utf8')).join('\n\n');
    const bundledNotices = fs.readFileSync(path.join(__dirname, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    const noticeText = notices + '\n\n' + bundledNotices + '\n\ntiny-sha256 by Geraint Luff: public domain.\n';
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), noticeText);
    zip.file('THIRD_PARTY_NOTICES.txt', noticeText);
    for (const [name, source] of Object.entries(files)) {
        const bytes = fs.readFileSync(path.join(__dirname, source));
        if (name.endsWith('.js')) {
            checkLegacySyntax(bytes.toString('utf8'), name);
            if (/sourceMappingURL=/.test(bytes.toString('utf8'))) throw new Error('Unexpected source map in ' + name);
        }
        fs.mkdirSync(path.dirname(path.join(stage, name)), { recursive: true });
        fs.writeFileSync(path.join(stage, name), bytes);
        zip.file(name, bytes);
    }
    const artifacts = path.resolve(__dirname, '../artifacts', pkg.version);
    fs.mkdirSync(artifacts, { recursive: true });
    const output = path.join(artifacts, 'TizenTubeLegacy-unsigned.wgt');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(output, bytes);
    const release = new JSZip();
    release.file('TizenTube-old-tizen-v' + pkg.version + '-resign-required.wgt', bytes);
    release.file('LICENSE', fs.readFileSync(path.resolve(__dirname, '../LICENSE')));
    release.file('THIRD_PARTY_NOTICES.txt', noticeText);
    fs.writeFileSync(path.join(artifacts, 'TizenTube-old-tizen-v' + pkg.version + '.zip'),
        await release.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    console.log('Built TizenTube Legacy ' + pkg.version + '; packaged JavaScript passed ES5 parsing.');
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
