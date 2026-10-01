// Builds demo/demo.html: index.html + the real backend/Code.gs running in-browser on fictional data.
// usage: node demo/build.js [out.html]
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const gas = read('backend/Code.gs');
if (/<\/script/i.test(gas)) throw new Error('Code.gs contains </script');

const demoScript = `<script>
window.APEX_DEMO = true;
${read('demo/runtime.js')}
window.APEX_DEMO_API = (function () {
  const svc = createGasServices();
  const server = (function (SpreadsheetApp, PropertiesService, CacheService, LockService, ContentService, Utilities, console) {
${gas}
${read('demo/seed.js')}
    seedDemo();
    return { call: req => { Object.keys(ROWS_CACHE_).forEach(k => delete ROWS_CACHE_[k]); return JSON.parse(doPost({ postData: { contents: JSON.stringify(req) } }).getContent()); } };
  })(svc.SpreadsheetApp, svc.PropertiesService, svc.CacheService, svc.LockService, svc.ContentService, svc.Utilities, svc.console);
  return req => new Promise(res => setTimeout(() => res(server.call(req)), 120 + Math.random() * 180));
})();
</script>
`;
let html = read('index.html')
  .replace('<title>ApexCare Nursing</title>', '<title>ApexCare Nursing Demo</title>')
  .replace('<script>\n\'use strict\';', () => demoScript + '<script>\n\'use strict\';');
if (!html.includes('window.APEX_DEMO = true')) throw new Error('inject failed');
fs.writeFileSync(process.argv[2] || path.join(__dirname, 'demo.html'), html);
console.log('built', (html.length / 1024).toFixed(0) + ' KB');
