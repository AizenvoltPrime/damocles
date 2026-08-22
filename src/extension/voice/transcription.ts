import type { VoiceProvider } from "../../shared/types/voice";

interface TranscribeParams {
  audioBuffer: Buffer;
  mimeType: string;
  provider: VoiceProvider;
  apiKey: string;
  language: string;
}

export async function transcribe(params: TranscribeParams): Promise<string> {
  switch (params.provider) {
    case "openai-whisper":
      return transcribeWhisper(params);
    case "deepgram":
      return transcribeDeepgram(params);
    case "google-cloud-stt":
      return transcribeGoogleSTT(params);
  }
}

async function transcribeWhisper({ audioBuffer, mimeType, apiKey, language }: TranscribeParams): Promise<string> {
  const isWav = mimeType.includes("wav");
  // A copy into a plain ArrayBuffer: `Buffer` is backed by ArrayBufferLike, which the DOM `Blob`
  // and `fetch` overloads reject, so passing it directly only type-checks without the DOM lib.
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, isWav ? "audio.wav" : "audio.webm");
  formData.append("model", "whisper-1");
  formData.append("language", language);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as { text: string };
  return result.text;
}

async function transcribeDeepgram({ audioBuffer, mimeType, apiKey, language }: TranscribeParams): Promise<string> {
  const response = await fetch(
    `https://api.deepgram.com/v1/listen?model=nova-2&language=${encodeURIComponent(language)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mimeType,
      },
      body: new Uint8Array(audioBuffer),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram API error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as {
    results: { channels: { alternatives: { transcript: string }[] }[] };
  };
  return result.results.channels[0]?.alternatives[0]?.transcript ?? "";
}

function readWavSampleRate(buffer: Buffer): number {
  if (buffer.length >= 28 && buffer.toString("ascii", 0, 4) === "RIFF") {
    return buffer.readUInt32LE(24);
  }
  return 44100;
}

async function transcribeGoogleSTT({ audioBuffer, mimeType, apiKey, language }: TranscribeParams): Promise<string> {
  const audioBase64 = audioBuffer.toString("base64");
  const isWav = mimeType.includes("wav");

  const response = await fetch(
    "https://speech.googleapis.com/v1/speech:recognize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        config: {
          encoding: isWav ? "LINEAR16" : "WEBM_OPUS",
          sampleRateHertz: isWav ? readWavSampleRate(audioBuffer) : 48000,
          languageCode: language,
        },
        audio: { content: audioBase64 },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google STT API error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as {
    results?: { alternatives: { transcript: string }[] }[];
  };
  return result.results?.map(r => r.alternatives[0]?.transcript).join(" ") ?? "";
}
