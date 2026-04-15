import { create, open } from '@memvid/sdk';
import { existsSync } from 'fs';

const MEMORY_PATH = process.env.MEMORY_PATH ?? 'chatbot-memory.mv2';

export async function getWriter() {
  if (!existsSync(MEMORY_PATH)) {
    const mem = await create(MEMORY_PATH);
    await mem.enableLex();
    return mem;
  }
  return open(MEMORY_PATH, 'basic');
}

export async function getReader() {
  return open(MEMORY_PATH, 'basic', { readOnly: true });
}
