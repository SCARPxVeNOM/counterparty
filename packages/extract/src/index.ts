export {
  AMBIGUITY_KINDS,
  AMBIGUITY_PENALTIES,
  EXTRACTION_CEILING,
  confidenceFrom,
  costAmbiguities,
  priceAmbiguities,
  rupeeAmounts,
  type Ambiguity,
  type AmbiguityKind,
} from './ambiguity';

export {
  ExtractionError,
  type ExtractionResult,
  type ExtractionSource,
  type FieldReport,
} from './types';

export { extractCatalog, extractEntry, readSource, type CatalogExtraction } from './extract';

export {
  extractFromPaymentPage,
  isRazorpayPaymentPage,
  parsePaymentPageData,
  STRUCTURED_PRICE_CONFIDENCE,
} from './razorpay-page';

export { loadFixture, fetchSource, FIXTURES, type FixtureName } from './fixtures';
