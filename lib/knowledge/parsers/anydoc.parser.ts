import type { ParsedDocument, ParserInput } from "./parser.types";

function titleFromFileName(fileName?: string): string | undefined {
	if (!fileName) return undefined;
	const title = fileName
		.replace(/\.[^.]+$/, "")
		.replace(/[-_]+/g, " ")
		.trim();
	return title || undefined;
}

export async function parseAnyDoc(input: ParserInput): Promise<ParsedDocument> {
	if (!input.buffer) throw new Error("[anydoc] a file buffer is required");

	const packageName = "@firecrawl/anydoc";
	const { formatFromExtension, toMarkdownBytes } = await import(packageName);
	const extension = input.fileName?.split(".").pop();
	const format = extension ? formatFromExtension(extension) : null;
	const text = (await toMarkdownBytes(input.buffer, format)).trim();
	if (!text) throw new Error("[anydoc] no readable text found in document");

	return {
		title: titleFromFileName(input.fileName),
		text,
		contentType: input.contentType,
		metadata: {
			parser: "firecrawl-anydoc",
			format: format ?? "detected-from-bytes",
		},
	};
}
