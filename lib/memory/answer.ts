import { generateText } from 'ai'
import { groq } from '@ai-sdk/groq'

export type AnswerInput = { question: string; context: string }

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
