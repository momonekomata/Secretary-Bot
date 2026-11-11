import { deflateRawSync } from 'node:zlib';
import type { HealthDb } from './healthdb';
import { t } from './i18n';
import { flowOf } from './money';
import type { Store } from './store';
import { formatTime, localClock } from './time';

// --- a small ZIP writer (deflate, UTF-8 names), so the export opens anywhere without extra tools ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: { name: string; data: Buffer }[], date = new Date()): Buffer {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(cd, name);
    offset += local.length + name.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

// --- CSV ---

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with a UTF-8 byte-order mark, so Excel shows Thai and Japanese text correctly. */
export function csv(header: string[], rows: unknown[][]): Buffer {
  return Buffer.from(`﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`, 'utf8');
}

/** Everything the bot keeps about this chat's user, as a .zip of CSV files plus a JSON of settings. */
export function buildExport(store: Store, db: HealthDb, chatKey: string, timeZone: string, now = new Date()): { name: string; data: Buffer; summary: string } {
  const food = store.food(chatKey);
  const weights = store.weights(chatKey);
  const days = db.range('0000-01-01', '9999-12-31');
  const memories = store.memories(chatKey);
  const money = store.money(chatKey);
  const foodDb = store.foodDb(chatKey);
  const usage = store.usage();
  const clock = (iso: string) => localClock(new Date(iso), timeZone);

  const files = [
    {
      name: 'food_diary.csv',
      data: csv(
        ['date', 'time', 'meal', 'food', 'portion', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
        food.map((f) => {
          const c = clock(f.ts);
          return [f.day, `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`, f.meal, f.name, f.portion, f.kcal, f.protein, f.carbs, f.fat];
        }),
      ),
    },
    { name: 'weight.csv', data: csv(['date', 'kg'], weights.map((w) => [w.day, w.kg])) },
    {
      name: 'health_daily.csv',
      data: csv(
        [
          'date', 'steps', 'kcal_burned', 'active_kcal', 'sleep_min', 'deep_min', 'rem_min', 'light_min', 'awake_min', 'bedtime', 'wake',
          'sleep_score', 'hr_avg', 'hr_min', 'hr_max', 'spo2_avg', 'spo2_min', 'weight_kg', 'body_fat_pct', 'skeletal_muscle_kg',
          'scale_bmr', 'workouts', 'workout_min', 'workout_kcal', 'hrv_ms', 'breaths_per_min', 'stress', 'floors', 'water_ml',
          'blood_pressure', 'kcal_eaten_samsung', 'source',
        ],
        days.map(([day, r]) => [
          day, r.steps, r.energy?.total, r.energy?.active, r.sleep?.asleepMin, r.sleep?.deepMin, r.sleep?.remMin, r.sleep?.lightMin,
          r.sleep?.awakeMin, r.sleep?.bedtime, r.sleep?.wake, r.sleep?.score, r.heart?.avg, r.heart?.min, r.heart?.max, r.oxygen?.avg,
          r.oxygen?.min, r.weight?.kg, r.weight?.bodyFatPct, r.weight?.skeletalMuscleKg, r.weight?.bmr, r.workouts?.length || '',
          r.workouts?.reduce((n, w) => n + w.minutes, 0) || '', r.workouts?.reduce((n, w) => n + w.kcal, 0) || '', r.extra?.hrv,
          r.extra?.respiratory, r.extra?.stress, r.extra?.floors, r.extra?.waterMl,
          r.extra?.bloodPressure ? `${r.extra.bloodPressure.systolic}/${r.extra.bloodPressure.diastolic}` : '', r.extra?.food?.kcal, r.source,
        ]),
      ),
    },
    {
      name: 'workouts.csv',
      data: csv(
        ['date', 'start', 'type', 'minutes', 'km', 'kcal', 'steps', 'avg_hr', 'max_hr'],
        days.flatMap(([day, r]) => (r.workouts ?? []).map((w) => [day, w.start, w.type, w.minutes, w.km, w.kcal, w.steps, w.avgHr, w.maxHr])),
      ),
    },
    {
      name: 'samsung_food_log.csv',
      data: csv(['date', 'meal', 'food', 'kcal'], days.flatMap(([day, r]) => (r.extra?.food?.items ?? []).map((i) => [day, i.meal, i.name, i.kcal]))),
    },
    {
      name: 'food_database.csv',
      data: csv(
        ['id', 'barcode', 'name', 'brand', 'serving', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'source', 'times_logged', 'updated', 'thaifcd_code'],
        foodDb.map((f) => [f.id, f.barcode, f.name, f.brand, f.serving, f.kcal, f.protein, f.carbs, f.fat, f.source, f.timesLogged, f.updatedAt.slice(0, 10), f.fcdCode]),
      ),
    },
    {
      name: 'money.csv',
      data: csv(
        ['id', 'date', 'time', 'direction', 'category', 'amount', 'currency', 'payee', 'account', 'reference', 'note', 'copay_discount', 'source'],
        money.map((t) => {
          const c = clock(t.ts);
          const dir = flowOf(t.category);
          return [t.id, t.day, `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`, dir === 'in' ? 'in' : dir === 'out' ? 'out' : 'moved', t.category, t.amount, t.currency ?? 'THB', t.payee, t.account, t.ref, t.note, t.discount, t.source];
        }),
      ),
    },
    { name: 'memories.csv', data: csv(['id', 'saved', 'memory'], memories.map((m) => [m.id, m.createdAt.slice(0, 10), m.text])) },
    {
      name: 'ai_usage.csv',
      data: csv(['time', 'kind', 'model', 'input_tokens', 'output_tokens', 'cost_usd'], usage.map((u) => [u.ts, u.kind, u.model, u.input + u.cacheRead + u.cacheWrite, u.output, u.cost.toFixed(6)])),
    },
    {
      name: 'profile_and_settings.json',
      data: Buffer.from(
        JSON.stringify(
          { exportedAt: now.toISOString(), timeZone, bodyProfile: store.body(chatKey), budget: store.budget(chatKey), settings: store.settings(), todos: store.todos(chatKey), reminders: store.reminders(chatKey), healthImports: db.imports() },
          null,
          2,
        ),
      ),
    },
  ];

  const stamp = localClock(now, timeZone).day;
  return {
    name: `secretary-bot-export-${stamp}.zip`,
    data: zip(files, now),
    summary: t(
      `💾 Your data as of ${formatTime(now, timeZone)}:\n` +
        `• food_diary.csv: ${food.length} entries\n• food_database.csv: ${foodDb.length} foods\n• weight.csv: ${weights.length} weigh-ins\n• money.csv: ${money.length} transactions\n` +
        `• health_daily.csv: ${days.length} days (sleep, steps, calories, heart rate, weight…)\n` +
        `• workouts.csv, samsung_food_log.csv, memories.csv (${memories.length}), ai_usage.csv\n` +
        '• profile_and_settings.json: body profile, budget, personality, preferences, to-dos, reminders\n' +
        'CSV files open in Excel, Google Sheets or Numbers.',
      `💾 ข้อมูลของคุณ ณ ${formatTime(now, timeZone)}:\n` +
        `• food_diary.csv: ${food.length} รายการ\n• food_database.csv: อาหาร ${foodDb.length} รายการ\n• weight.csv: ชั่งน้ำหนัก ${weights.length} ครั้ง\n• money.csv: ${money.length} รายการ\n` +
        `• health_daily.csv: ${days.length} วัน (การนอน ก้าวเดิน แคลอรี่ อัตราการเต้นของหัวใจ น้ำหนัก…)\n` +
        `• workouts.csv, samsung_food_log.csv, memories.csv (${memories.length}), ai_usage.csv\n` +
        '• profile_and_settings.json: ข้อมูลร่างกาย งบประมาณ บุคลิก สิ่งที่ตั้งค่าไว้ สิ่งที่ต้องทำ และการเตือน\n' +
        'ไฟล์ CSV เปิดได้ใน Excel, Google Sheets หรือ Numbers',
    ),
  };
}
