export {
  SellingAgent,
  primaryClause,
  toTurn,
  type SellingAgentContext,
  type SellingAgentTurn,
} from './selling-agent';

export {
  ADVERSARIAL_PERSONAS,
  BuyerAgent,
  LEGITIMATE_PERSONAS,
  PERSONAS,
  PERSONA_IDS,
  personaById,
  type BuyerContext,
  type Persona,
  type PersonaId,
} from './buyer';

export { Session, type SessionOptions, type TurnResult } from './session';

export {
  SEGMENT_SOURCES,
  campaignCostInr,
  isSynthetic,
  runCampaign,
  type CampaignOptions,
  type CampaignOutcome,
  type CampaignResult,
  type Segment,
  type SegmentMember,
  type SegmentSource,
} from './campaign';

export {
  BuyingAgent,
  type BuyerMandate,
  type BuyerOutcome,
  type BuyerRun,
  type BuyerStep,
  type BuyingAgentOptions,
  type MerchantEndpoint,
  type PaymentReceipt,
  type StepKind,
} from './buying-agent';

export {
  LocalMerchant,
  type LocalMerchantOptions,
  type PaymentExecutor,
} from './local-merchant';
