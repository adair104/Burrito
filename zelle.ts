// Backwards-compat shim — logic moved to email-payments.ts
export { checkEmailPayment as checkZellePayment, testPaymentEmail as testZelleConnection } from './email-payments.ts';
export type { PaymentEmailConfig as ZelleEmailConfig } from './email-payments.ts';
