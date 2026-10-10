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
  const clock = createDemoClock();
  window.APEX_DEMO_SET_NOW = clock.set;
  const server = (function (SpreadsheetApp, PropertiesService, CacheService, LockService, ContentService, Utilities, MailApp, ScriptApp, console, Date) {
${gas}
${read('demo/seed.js')}
    seedDemo();
    return { call: req => { Object.keys(ROWS_CACHE_).forEach(k => delete ROWS_CACHE_[k]); return JSON.parse(doPost({ postData: { contents: JSON.stringify(req) } }).getContent()); } };
  })(svc.SpreadsheetApp, svc.PropertiesService, svc.CacheService, svc.LockService, svc.ContentService, svc.Utilities, svc.MailApp, svc.ScriptApp, svc.console, clock.DemoDate);
  // يبدأ العرض على «السبت» ليجد المشاهد الاستمارة مفتوحة أياً كان اليوم الفعلي؛ ويمكن تغيير اليوم من القائمة العلوية
  (function () {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() - 6 + 7) % 7));
    window.APEX_DEMO_CLOCK = 'sat';
    clock.set(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).getTime());
  })();
  return req => new Promise(res => setTimeout(() => res(server.call(req)), 120 + Math.random() * 180));
})();
</script>
`;
let html = read('index.html')
  .replace('<title>Nursing</title>', '<title>Nursing Demo</title>')
  .replace(/API_URL: '[^']*'/, "API_URL: ''")   // العرض التجريبي لا يحمل رابط الخادم الحقيقي
  .replace('<script>\n\'use strict\';', () => demoScript + '<script>\n\'use strict\';');
if (!html.includes('window.APEX_DEMO = true')) throw new Error('inject failed');
// --artifact: remove the document wrapper (html/head/body, charset, viewport) for hosts that add their own skeleton
if (process.argv.includes('--artifact')) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta (charset|name="(viewport|theme-color)")[^>]*>\s*/g, '').replace(/<meta name="description"[^>]*>\s*/, '');
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
  html = title + '\n' + head.replace(title, '').trim() + '\n' + body;
}
fs.writeFileSync(process.argv.find(a => a.endsWith('.html')) || path.join(__dirname, 'demo.html'), html);
console.log('built', (html.length / 1024).toFixed(0) + ' KB');
