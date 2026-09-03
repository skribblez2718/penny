import { ReceiptAuthority } from "../../src/receipts.js";

/** Shared in-memory authority for deterministic engine tests with no state-key I/O. */
export const TEST_RECEIPT_AUTHORITY = ReceiptAuthority.createEphemeral();
