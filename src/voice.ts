import type { GenerateContent } from './llm/gemini';
import { geminiText, geminiUsage } from './llm/gemini';
import type { Usage } from './models';

export interface AudioInput {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface Transcript {
  language: string;
  transcript: string;
  /** Empty when the note is already in the target language. */
  translation: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', description: 'Spoken language, in English, e.g. "Thai".' },
    transcript: { type: 'string', description: 'Verbatim transcript in the original language.' },
    translation: { type: 'string', description: 'Translation into the target language, or "" if already in it.' },
  },
  required: ['language', 'transcript', 'translation'],
};

/**
 * Transcribes (and translates) a voice note with Gemini's native audio understanding.
 * Gemini accepts Telegram's .ogg voice notes directly, so no ffmpeg conversion is needed.
 */
export async function transcribe(
  generate: GenerateContent,
  model: string,
  audio: AudioInput,
  translateTo: string,
  onUsage: (u: Usage) => void,
): Promise<Transcript> {
  const res = await generate({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: audio.mimeType, data: audio.data } },
          {
            text:
              `Transcribe this voice note word for word and detect its language. ` +
              `If it is not in ${translateTo}, also translate it into ${translateTo}; otherwise leave translation empty.`,
          },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA },
  });
  onUsage(geminiUsage(model, res));
  const text = geminiText(res);
  try {
    const t = JSON.parse(text) as Transcript;
    return { language: t.language ?? 'unknown', transcript: t.transcript ?? '', translation: t.translation ?? '' };
  } catch {
    return { language: 'unknown', transcript: text, translation: '' };
  }
}

/** What the agent receives after a voice note: it summarises and creates any tasks it mentions. */
export function voicePrompt(t: Transcript, translateTo: string): string {
  return [
    `[The user sent a voice note in ${t.language}.]`,
    `Transcript: ${t.transcript}`,
    t.translation ? `${translateTo} translation: ${t.translation}` : '',
    '',
    `Reply in ${translateTo}: give a short summary and the key action items. If the note asks for tasks, reminders or ` +
      'appointments, create them now with your tools (Google Tasks / Calendar when connected, otherwise the to-do list and ' +
      'reminders), resolving relative dates from the current time, and list what you created.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
