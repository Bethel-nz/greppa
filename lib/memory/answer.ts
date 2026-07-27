import { generateText } from 'ai'
import { groq } from '@ai-sdk/groq'

export type AnswerInput = { question: string; context: string }

/**
 * Grounded answer generation for askScopedMemory.
 *
 * Kept in its own module so the retrieval path can be tested without a model
 * call: tests mock this module rather than the whole AI SDK. Memvid used to
 * provide this via mem.ask(); retrieval and generation are separate concerns
 * and separating them lets the model be swapped without touching the store.
 */
export async function generateAnswer({ question, context }: AnswerInput): Promise<string> {
  const { text } = await generateText({
    model: groq(process.env.GREPPA_ANSWER_MODEL ?? 'llama-3.3-70b-versatile'),
    system:
      'Answer strictly from the provided context. If the context does not contain the answer, ' +
      'say you do not have that information. Do not speculate.',
    prompt: `Context:\n${context}\n\nQuestion: ${question}`,
  })
  return text
}
