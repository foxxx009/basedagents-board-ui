/* Hostile fixtures for the XSS posture test.
 * Every payload is designed to execute if (and only if) the UI uses innerHTML,
 * insertAdjacentHTML, document.write, eval, or a javascript: URL on API data.
 * None may result in: a dialog, a global side effect, a network beacon, or a
 * DOM node whose text content was altered by the payload.
 */
window.HOSTILE_FIXTURES = [
  {
    name: 'img onerror',
    title: '<img src=x onerror="window.__XSS_IMG__=1">',
    description: '<img src=x onerror="window.__XSS_IMG__=1"> plain <b>bold</b> text.',
  },
  {
    name: 'script tag',
    title: '<script>window.__XSS_SCRIPT__=1<\/script>Task title',
    description: '<script>window.__XSS_SCRIPT__=1<\/script> body text.',
  },
  {
    name: 'svg onload',
    title: '<svg/onload=window.__XSS_SVG__=1>',
    description: '<svg onload="window.__XSS_SVG__=1"></svg> svg payload',
  },
  {
    name: 'javascript: href',
    title: '<a href="javascript:window.__XSS_HREF__=1">click me</a>',
    description: '[link](javascript:window.__XSS_HREF__=1) and <a href="javascript:alert(1)">x</a>',
  },
  {
    name: 'iframe srcdoc',
    title: '<iframe srcdoc="<script>window.__XSS_IFRAME__=1<\/script>"></iframe>',
    description: '<iframe src="javascript:window.__XSS_IFRAME__=1"></iframe>',
  },
  {
    name: 'attribute breakout',
    title: '" onmouseover="window.__XSS_ATTR__=1" x="',
    description: "' onfocus='window.__XSS_ATTR__=1' autofocus='",
  },
  {
    name: 'event handler entity',
    title: '<div onerror=window.__XSS_ENT__=1>&lt;img src=x onerror=alert(1)&gt;</div>',
    description: '&#60;script&#62;window.__XSS_ENT__=1&#60;/script&#62;',
  },
  {
    name: 'style/expression',
    title: '<style>@import "//evil.test/x.css";</style><div style="width:expression(alert(1))">s</div>',
    description: '<style>body{display:none}</style><link rel=stylesheet href="//evil.test/x.css">',
  },
  {
    name: 'data uri iframe',
    title: '<iframe src="data:text/html,<script>window.__XSS_DATA__=1<\/script>"></iframe>',
    description: '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>',
  },
  {
    name: 'markdown image beacon',
    title: '![x](https://evil.test/beacon.png?leak=1)',
    description: '![img](https://evil.test/track.png) <a href="https://evil.test/track?a=1">real link</a>',
  },
  {
    name: 'null byte + template',
    title: '`<script>${window.__XSS_TPL__=1}</script>`',
    description: '${alert(1)} {{constructor.constructor("alert(1)")()}}',
  },
  {
    name: 'closing tag injection',
    title: '</title></head><body><script>window.__XSS_CLOSE__=1<\/script>',
    description: '</textarea><script>window.__XSS_CLOSE__=1<\/script>',
  },
];
