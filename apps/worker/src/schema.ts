import { z } from 'zod';

const timed = { startSec: z.number().finite().nonnegative(), endSec: z.number().finite().positive() };
export const analysisSchema = z.object({
  summary: z.string().trim().min(1).max(1600),
  uncertainties: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  observations: z.array(z.object({ ...timed, description: z.string().trim().min(1).max(1000) }).strict()).max(50),
  candidateEvents: z.array(z.object({
    ...timed,
    type: z.enum(['possible_fall', 'prolonged_lying']),
    evidence: z.string().trim().min(1).max(1500),
    uncertainties: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  }).strict()).max(20),
}).strict();
export type AnalysisResult = z.infer<typeof analysisSchema>;

export function validateAnalysis(input: unknown, durationSec: number): AnalysisResult {
  const result = analysisSchema.parse(input);
  for (const item of [...result.observations, ...result.candidateEvents]) {
    if (item.startSec >= item.endSec || item.endSec > durationSec + 0.001) throw new Error('Model timestamps are outside the segment or not ordered.');
  }
  for (const event of result.candidateEvents) {
    // Require a temporal observation for the candidate; an isolated frame is insufficient.
    const observations = result.observations.filter(item => item.startSec <= event.startSec && item.endSec >= event.endSec);
    if (!observations.length) throw new Error('Candidate event lacks a supporting temporal observation.');
    if (event.type === 'prolonged_lying' && event.endSec - event.startSec < 3) throw new Error('Prolonged lying requires at least 3 seconds of temporal evidence.');
  }
  return result;
}
