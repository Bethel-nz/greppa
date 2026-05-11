import { create, open } from '@memvid/sdk';

const MEMORY_PATH = process.env.MEMORY_PATH ?? 'chatbot-memory.mv2';

export async function getWriter() {
  const exists = await Bun.file(MEMORY_PATH).exists();
  if (!exists) {
    const mem = await create(MEMORY_PATH);
    await mem.enableLex();
    return mem;
  }
  return open(MEMORY_PATH, 'basic');
}

export async function getReader() {
  return open(MEMORY_PATH, 'basic', { readOnly: true });
}
