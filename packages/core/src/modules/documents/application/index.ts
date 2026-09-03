export type {
  DocumentQuery,
  DocumentRepository,
  DocumentTextRepository,
  ExtractedText,
  TextExtractionInput,
  TextExtractorPort,
} from './ports.js';
export {
  DOCUMENT_RECEIVED,
  DOCUMENT_STREAM_TYPE,
  IngestDocument,
  type IngestDocumentDependencies,
  type IngestDocumentInput,
  IngestDocumentInputSchema,
  type IngestedDocument,
} from './ingest-document.js';
