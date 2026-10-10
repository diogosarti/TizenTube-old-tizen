'use strict';
var URL = require('url');
var domains = /(^|\.)(youtube\.com|ytimg\.com|googlevideo\.com|gstatic\.com|googleapis\.com|googleusercontent\.com|ggpht\.com|google\.com|ajay\.app)$/;
function targetFor(requestPath) {
    var match = /^\/__proxy\/(https?)\/([^/]+)(\/.*)?$/.exec(requestPath);
    var target = URL.parse(match ? match[1] + '://' + match[2] + (match[3] || '/') : 'https://www.youtube.com' + requestPath);
    if (!domains.test(target.hostname) || target.auth || (target.port && target.port !== '443' && target.port !== '80')) throw new Error('Blocked target');
    return target;
}
function rewrite(text, origin) {
    function replacement(_, scheme, host) {
        return /^(www\.)?youtube\.com$/.test(host) ? origin : origin + '/__proxy/' + (scheme || 'https') + '/' + host;
    }
    var host = '((?:[a-zA-Z0-9-]+\\.)*(?:youtube\\.com|ytimg\\.com|googlevideo\\.com|gstatic\\.com|googleapis\\.com|googleusercontent\\.com|ggpht\\.com|google\\.com|ajay\\.app))';
    var plain = new RegExp('(?:(http|https):)?//' + host + '(?=[/\\s"\'<>?#),;]|$)', 'g');
    var escaped = new RegExp('(?:(http|https):)?\\\\/\\\\/' + host + '(?=\\\\/|[\\s"\'<>?#),;]|$)', 'g');
    return text.replace(escaped, function () { return replacement.apply(null, arguments).replace(/\//g, '\\/'); }).replace(plain, replacement);
}
function html(source, origin, mods) {
    source = source.replace(/\s(?:integrity|nonce|crossorigin)=(?:"[^"]*"|'[^']*')/gi, '');
    source = source.replace(/<head([^>]*)>/i, '$&<script src="/__legacy/logger.js"></script><script src="/__legacy/frame.js"></script><script src="/__legacy/compat.js"></script>');
    if (mods) source = source.replace(/<body([^>]*)>/i, '$&<script src="/__legacy/userScript.js"></script>');
    return rewrite(source, origin);
}
module.exports = { targetFor: targetFor, rewrite: rewrite, html: html };
