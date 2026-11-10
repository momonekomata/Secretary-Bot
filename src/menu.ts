import type { Lang } from './i18n';

/**
 * Every command, for Telegram's "/" menu: [command, English description, Thai description].
 * A test checks that every command in commands.ts is listed here (or is an alias in MENU_ALIASES).
 */
export const MENU: [string, string, string][] = [
  ['help', 'Everything I can do', 'ทุกอย่างที่ฉันทำได้'],
  ['brief', 'Morning briefing now', 'สรุปข่าวเช้าตอนนี้'],
  ['news', 'News digest (or /news topic)', 'สรุปข่าว (หรือ /news หัวข้อ)'],
  ['topics', 'News watchlist', 'หัวข้อข่าวที่ติดตาม'],
  ['addtopic', 'Add a news topic', 'เพิ่มหัวข้อข่าว'],
  ['removetopic', 'Remove a news topic', 'ลบหัวข้อข่าว'],
  ['weather', "Today's weather and air quality", 'อากาศและคุณภาพอากาศวันนี้'],
  ['forecast', '7-day forecast', 'พยากรณ์อากาศ 7 วัน'],
  ['weekend', 'Weekend weather planner', 'วางแผนวันหยุดตามสภาพอากาศ'],
  ['setcity', 'Set your home city', 'ตั้งเมืองของคุณ'],
  ['todo', 'Show to-do list', 'ดูรายการสิ่งที่ต้องทำ'],
  ['add', 'Add a to-do', 'เพิ่มสิ่งที่ต้องทำ'],
  ['done', 'Mark a to-do done', 'ทำเครื่องหมายว่าเสร็จแล้ว'],
  ['clear', 'Clear the to-do list', 'ล้างรายการสิ่งที่ต้องทำ'],
  ['calendar', 'Upcoming Google Calendar events', 'นัดหมายที่กำลังจะมาถึงใน Google Calendar'],
  ['inbox', 'Unread Gmail', 'อีเมลที่ยังไม่ได้อ่าน'],
  ['mail', 'Search Gmail', 'ค้นหาอีเมล'],
  ['gtask', 'Google Tasks (list, or add with text)', 'Google Tasks (ดู หรือเพิ่มพร้อมข้อความ)'],
  ['gdone', 'Tick off a Google Task', 'ทำเครื่องหมาย Google Task ว่าเสร็จ'],
  ['drive', 'Search Google Drive', 'ค้นหาไฟล์ใน Google Drive'],
  ['places', 'Find places nearby', 'ค้นหาสถานที่ใกล้ๆ'],
  ['budget', 'Spending this month and budgets', 'รายจ่ายเดือนนี้และงบประมาณ'],
  ['food', "Today's food and calories", 'อาหารและแคลอรี่วันนี้'],
  ['bmi', 'BMI, BMR and calorie target', 'BMI, BMR และเป้าหมายแคลอรี่'],
  ['profile', 'Your body profile', 'ข้อมูลร่างกายของคุณ'],
  ['weight', 'Log or show your weight', 'บันทึกหรือดูน้ำหนัก'],
  ['health', 'Watch data: steps, sleep, heart rate', 'ข้อมูลนาฬิกา: ก้าวเดิน การนอน หัวใจ'],
  ['healthimport', 'Import a Samsung Health export', 'นำเข้าข้อมูลจาก Samsung Health'],
  ['review', 'Do your WaniKani reviews here', 'ทำรีวิว WaniKani ที่นี่'],
  ['kanji', 'Kanji of the day', 'คันจิประจำวัน'],
  ['word', 'Japanese word of the day', 'คำศัพท์ญี่ปุ่นประจำวัน'],
  ['jlpt', 'Level for kanji and word of the day', 'ระดับของคันจิและคำศัพท์ประจำวัน'],
  ['roleplay', 'Start a roleplay or Japanese practice', 'เริ่มบทบาทสมมติหรือฝึกภาษาญี่ปุ่น'],
  ['persona', 'Choose my personality', 'เลือกบุคลิกของฉัน'],
  ['name', 'Rename me', 'เปลี่ยนชื่อฉัน'],
  ['prefs', 'Your standing preferences', 'สิ่งที่คุณตั้งค่าไว้ให้ฉันทำเสมอ'],
  ['voice', 'When to answer with voice', 'เมื่อไหร่ให้ตอบเป็นเสียง'],
  ['say', 'Say something out loud', 'พูดข้อความออกเสียง'],
  ['voices', 'Hear voice samples and pick one', 'ฟังตัวอย่างเสียงแล้วเลือก'],
  ['ttsvoice', 'Choose my speaking voice', 'เลือกเสียงพูดของฉัน'],
  ['translate', 'Language for voice-note translation', 'ภาษาที่ใช้แปลข้อความเสียง'],
  ['settings', 'AI model, effort, voice translation', 'โมเดล AI ความพยายามในการคิด และการแปลเสียง'],
  ['model', 'Switch AI model', 'เปลี่ยนโมเดล AI'],
  ['effort', 'How hard the AI thinks', 'ระดับการคิดของ AI'],
  ['limit', 'Daily AI spending limits (USD)', 'วงเงินค่า AI ต่อวัน (USD)'],
  ['stats', 'AI usage and cost', 'การใช้งานและค่าใช้จ่าย AI'],
  ['export', 'Download your data', 'ดาวน์โหลดข้อมูลของคุณ'],
  ['cleanup', 'Archive old usage logs now', 'เก็บบันทึกการใช้งานเก่าตอนนี้'],
  ['status', 'Check connections', 'ตรวจสอบการเชื่อมต่อ'],
  ['reset', 'Forget this conversation', 'ลืมบทสนทนานี้'],
  ['id', 'Your user and chat id', 'ไอดีผู้ใช้และแชท'],
];

/** Other names for listed commands (not shown in the menu, to keep it short). */
export const MENU_ALIASES = ['start', 'money', 'pref', 'limits', 'cap', 'remotopic', 'deltopic'];

export function menuFor(lang: Lang): { command: string; description: string }[] {
  return MENU.map(([command, en, th]) => ({ command, description: lang === 'th' ? th : en }));
}
