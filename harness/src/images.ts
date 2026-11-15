import { STYLES, type StylePreset } from "@dreamsy/format";

export interface ImageRequest {
  prompt: string;
  style: StylePreset;
  palette?: string[];
  /** Style/reference images (player uploads, style references). */
  references: { mediaType: string; base64: string }[];
  aspect: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
}

export interface ImageResult {
  bytes: Uint8Array;
  ext: "png" | "jpg" | "webp";
  model: string;
  prompt: string;
}

export interface ImageGen {
  readonly available: boolean;
  generate(req: ImageRequest, signal: AbortSignal): Promise<ImageResult>;
}

export function fullImagePrompt(req: ImageRequest): string {
  const s = STYLES[req.style];
  return [
    req.prompt,
    s.assetPrompt,
    req.palette?.length ? `use only this color palette: ${req.palette.join(", ")}` : "",
    req.references.length ? "match the art style of the reference images" : "",
    "no text, no watermark, no border",
  ].filter(Boolean).join(". ");
}

export const disabledImages: ImageGen = {
  available: false,
  async generate() {
    throw new Error("image generation is not configured (set GEMINI_API_KEY); build with solid colors and primitives instead");
  },
};

/** Gemini image model. Model id is configurable: GEMINI_IMAGE_MODEL. */
export async function geminiImages(apiKey: string, model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-lite-image" /* Nano Banana 2 Lite */): Promise<ImageGen> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });
  const gen: ImageGen & { available: boolean } = {
    available: true,
    async generate(req, signal) {
      const prompt = fullImagePrompt(req);
      const res = await ai.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [
            ...req.references.slice(0, 3).map((r) => ({ inlineData: { mimeType: r.mediaType, data: r.base64 } })),
            { text: prompt },
          ],
        }],
        config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspect }, abortSignal: signal },
      });
      for (const part of res.candidates?.[0]?.content?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data) {
          const mime = part.inlineData?.mimeType ?? "image/png";
          const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
          return { bytes: new Uint8Array(Buffer.from(data, "base64")), ext, model, prompt };
        }
      }
      throw new Error("image model returned no image");
    },
  };
  // A quota/billing error (free tier = 0 image quota) won't fix itself mid-session: stop offering
  // generate_image so builds don't burn turns on it. It comes back on the next worker start.
  const inner = gen.generate;
  gen.generate = async (req, signal) => {
    try {
      return await inner(req, signal);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/\b429\b|RESOURCE_EXHAUSTED|quota|billing/i.test(msg)) {
        gen.available = false;
        console.error("! Gemini image quota exhausted — image generation disabled until restart (enable billing on the GEMINI key)");
      }
      throw e;
    }
  };
  return gen;
}
