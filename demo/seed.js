/* Fictional demo data. Appended INSIDE the Code.gs closure so it can call the backend internals directly.
   Everything is generated relative to "today", so the dashboards always look current. */
function seedDemo() {
  const clr = () => Object.keys(ROWS_CACHE_).forEach(k => delete ROWS_CACHE_[k]);
  let _s = 20260926;
  const rnd = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0; let t = Math.imul(_s ^ _s >>> 15, 1 | _s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const PW = 'demo';

  setup(); clr();
  rows_(S.USERS).forEach(u => { const salt = Utilities.getUuid(); setCells_(S.USERS, u._row, { salt: salt, pass_hash: hash_(PW, salt), must_change: 'no' }); });
  clr();

  const cfg = settings_();
  const weeks = weeksBack_(currentWeek_(cfg), 12);
  const now = new Date();
  const ago = n => dateStr_(addDays_(parseDate_(weeks[weeks.length - 1]), -7 * n));

  // [اسم, فرع, عيادات, موثوقية التسليم, أسابيع منذ البداية, أسابيع منذ التوقف (إن توقفت)]
  const NURSES = [
    ['Layla Hassan', 'BURIDAH', ['BUR-C1', 'BUR-C2'], 1, 30],
    ['Mona Saleh', 'BURIDAH', ['BUR-C3'], .95, 28],
    ['Rina Dewi', 'BURIDAH', ['BUR-C4', 'BUR-C5'], .9, 26],
    ['Maria Santos', 'BURIDAH', ['BUR-C6'], .6, 30],
    ['Anita Rao', 'BURIDAH', ['BUR-C7', 'BUR-C8'], .85, 24],
    ['Fatima Noor', 'BURIDAH', ['BUR-C9'], .75, 20],
    ['Joy Reyes', 'BURIDAH', ['BUR-C10', 'BUR-C11'], .95, 22],
    ['Aisha Khan', 'BURIDAH', ['BUR-C12', 'BUR-C13'], .5, 18],
    ['Dina Putri', 'BURIDAH', ['BUR-HYDRAFACIAL', 'BUR-CLARITY'], .9, 16],
    ['Hana Yusuf', 'BURIDAH', ['BUR-GENTLE', 'BUR-DERMA'], .8, 14],
    ['Grace Lim', 'BURIDAH', ['BUR-STERIL'], .9, 5],
    ['Nora Ali', 'ONIZAH', ['ONZ-C1', 'ONZ-C2'], 1, 30],
    ['Sana Malik', 'ONIZAH', ['ONZ-C3', 'ONZ-C4'], .85, 26],
    ['Lina Kareem', 'ONIZAH', ['ONZ-STERIL'], .7, 18],
    ['Ayu Lestari', 'BURIDAH', [], 0, 30, 'inactive'],
  ];
  const slug = n => n.toLowerCase().replace(/\s+/g, '.');
  const users = NURSES.map(n => {
    const c = newUserRow_({ username: slug(n[0]) + '@demo.apex', name: n[0], email: slug(n[0]) + '@demo.apex', role: 'nurse',
      branch: n[1], clinics: n[2].join(','), start_date: ago(n[4]), status: n[5] || 'active',
      end_date: n[5] === 'inactive' ? weeks[3] : '' });
    const salt = Utilities.getUuid();
    c.row.salt = salt; c.row.pass_hash = hash_(PW, salt); c.row.must_change = 'no';
    return c.row;
  });
  appendObjects_(S.USERS, users); clr();

  // إجازات: Dina Putri في إجازة حالية، وJoy Reyes أنهت إجازة سابقة
  const LEAVES = {
    'Dina Putri': [{ from: weeks[10], to: dateStr_(addDays_(parseDate_(weeks[11]), 10)) }],
    'Joy Reyes': [{ from: weeks[4], to: dateStr_(addDays_(parseDate_(weeks[5]), 3)) }],
  };
  const leaveRows = [];
  Object.keys(LEAVES).forEach(name => LEAVES[name].forEach((l, i) => leaveRows.push({
    leave_id: 'LD' + leaveRows.length, username: slug(name) + '@demo.apex', from_date: l.from, to_date: l.to,
    cancelled: '', created_at: nowStr_(), created_by: 'الموارد البشرية' })));
  appendObjects_(S.LEAVES, leaveRows); clr();
  const onLeaveWeek = (name, w) => (LEAVES[name] || []).some(l => l.from <= w && w <= l.to);
  const FORCE_MISS = { 'Aisha Khan': [9, 10, 11], 'Maria Santos': [10, 11] };
  const PERSIST = { 'BUR-C5': 'Low speed handpiece', 'BUR-C9': 'Extraction forceps', 'ONZ-C2': 'Light cure unit' };
  const ITEMS = ['Adrenaline', 'Lidocaine 2%', 'Composite A2', 'Alveogyl', 'Dexamethasone', 'Bonding agent', 'Gutta-percha', 'Impression material'];
  const TOOLS = ['Low speed handpiece', 'Mouth mirror', 'Extraction forceps', 'Light cure unit', 'Composite spatula', 'Scaler tip', 'Suction tip', 'Bur kit'];
  const clinicById = {}; clinics_().forEach(c => clinicById[c.clinic_id] = c);
  const fmt = d => Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd HH:mm:ss');
  let seq = 0;
  const reports = [];

  weeks.forEach((w, wi) => {
    NURSES.forEach((n, ni) => {
      const user = users[ni];
      const inactive = n[5] === 'inactive';
      if (wi < weeks.length - n[4]) return;     // لم تبدأ العمل بعد
      if (inactive && wi > 3) return;           // توقفت عن العمل قبل 8 أسابيع
      if (!inactive && (FORCE_MISS[n[0]] || []).indexOf(wi) >= 0) return;
      if (onLeaveWeek(n[0], w)) return;           // لا تُرفع تقارير أثناء الإجازة
      const prob = wi === weeks.length - 1 ? Math.min(.62, n[3]) : (inactive ? .9 : n[3]);
      (inactive ? ['BUR-STERIL'] : n[2]).forEach(cid => {
        if (n[0] === 'Layla Hassan' && cid === 'BUR-C2' && wi === weeks.length - 1) return; // تبقى جاهزة لتجربة الرفع
        if (n[0] === 'Layla Hassan' && cid === 'BUR-C2' && wi === 0) return;
        const demoNurseNow = n[0] === 'Layla Hassan' && cid === 'BUR-C1' && wi === weeks.length - 1;
        if (rnd() > prob && !demoNurseNow) return;
        const r0 = demoNurseNow ? 0 : rnd(), dayOff = r0 < .72 ? 0 : r0 < .9 ? 1 : r0 < .97 ? 2 : 3;
        const base = parseDate_(w); base.setDate(base.getDate() + dayOff);
        const when = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
        if (when > now) {                       // موعد التسليم لم يأتِ بعد اليوم: نُقدّمه ليكون قبل الآن مباشرة
          const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 60000;
          when.setTime(Math.max(midnight, now.getTime() - rnd() * 6 * 3600000));
        }
        const cls = classifySubmission_(when, cfg), clinic = clinicById[cid];
        const fridge = clinic.has_fridge === 'yes' ? (rnd() < .95 ? 'ok' : 'problem') : 'none';
        const temp = fridge === 'ok' && rnd() < .5 ? (rnd() < .93 ? Math.round((2.5 + rnd() * 4.5) * 10) / 10 : 10.5) : '';
        const soon = rnd() < .06, daysLeft = soon ? 10 + Math.floor(rnd() * 48) : 70 + Math.floor(rnd() * 300);
        const tools = [];
        if (PERSIST[cid] && wi >= 8) tools.push({ item: PERSIST[cid], qty: 2, severity: 'high', note: '' });
        else if (rnd() < .1) tools.push({ item: pick(TOOLS), qty: 1 + Math.floor(rnd() * 3), severity: rnd() < .2 ? 'high' : rnd() < .6 ? 'medium' : 'low', note: '' });
        const rep = {
          report_id: 'D' + String(++seq).padStart(5, '0'), submitted_at: fmt(when), week_start: cls.week, timing: cls.timing,
          username: user.username, nurse_name: n[0], branch: clinic.branch, clinic_id: cid, clinic_name: clinic.name,
          expiry_checked: rnd() < .97 ? 'yes' : 'no', earliest_expiry: dateStr_(addDays_(now, daysLeft)), expiry_item: pick(ITEMS),
          sterilization_ok: rnd() < .99 ? 'yes' : 'no', fridge: fridge, fridge_temp: temp,
          employee_card: rnd() < .9 ? 'yes' : 'no', cleanliness: rnd() < .04 ? 2 : rnd() < .5 ? 5 : 4,
          missing_tools: tools.length ? 'yes' : 'no', tools_json: JSON.stringify(tools), other_issue: '',
          notes: rnd() < .08 ? 'Clinic checked, all good.' : '', issues_count: 0, source: 'demo',
        };
        rep.issues_count = upsertIssues_(buildIssues_(rep, tools, cfg), rep);
        reports.push(rep);
      });
    });
  });
  appendObjects_(S.REPORTS, reports); clr();

  // مشاكل لم تتكرر منذ أسبوعين تُعتبر محلولة، والأحدث تبقى مفتوحة (بعضها قيد المعالجة)
  const cutoff = dateStr_(addDays_(parseDate_(weeks[weeks.length - 1]), -14));
  const DEPT = { supply: 'التموين', quality: 'الجودة', hr: 'الموارد البشرية' };
  const RES = { supply: ['تم الصرف من المستودع', 'تم الشراء وتسليم الصنف للعيادة'], quality: ['تمت المعالجة ومتابعة الممرضة', 'تم التصحيح وإعادة الفحص'], hr: ['تم تسليم بطاقة جديدة', 'تم إصدار بطاقة بدل فاقد'] };
  rows_(S.ISSUES).forEach(i => {
    if (i.last_seen < cutoff) {
      const created = parseDateTime_(i.created_at), done = new Date(created.getTime() + (2 + rnd() * 6) * 86400000);
      setCells_(S.ISSUES, i._row, { status: 'resolved', resolution: pick(RES[i.department]), resolved_at: fmt(done), updated_at: fmt(done), updated_by: DEPT[i.department], assigned_to: DEPT[i.department] });
    } else if (rnd() < .22) {
      setCells_(S.ISSUES, i._row, { status: 'in_progress', assigned_to: DEPT[i.department], updated_by: DEPT[i.department], updated_at: fmt(now) });
    }
  });
  clr();
}
