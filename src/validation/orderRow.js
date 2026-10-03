// Row validation (Section 8). One pure function: no database, no network, no
// logging, no files. It takes one CSV row (an object keyed by header name) and
// says whether it is a valid order, and if not, why.

// Every reason string lives here, so the upload summary can group by them and
// tests can refer to them by name instead of retyping the text.
const REASONS = Object.freeze({
  MISSING_ORDER_ID: 'missing order_id',
  ORDER_ID_TOO_LONG: 'order_id too long',
  MISSING_SELLER_ID: 'missing seller_id',
  SELLER_ID_TOO_LONG: 'seller_id too long',
  MISSING_SKU: 'missing sku',
  SKU_TOO_LONG: 'sku too long',
  MISSING_CUSTOMER_ID: 'missing customer_id',
  CUSTOMER_ID_TOO_LONG: 'customer_id too long',
  MISSING_MARKETPLACE: 'missing marketplace',
  UNKNOWN_MARKETPLACE: 'unknown marketplace',
  MISSING_QUANTITY: 'missing quantity',
  INVALID_QUANTITY: 'invalid quantity',
  MISSING_ORDER_DATE: 'missing order_date',
  INVALID_ORDER_DATE: 'invalid order_date',
  MISSING_ORDER_AMOUNT: 'missing order_amount',
  INVALID_ORDER_AMOUNT: 'invalid order_amount',
  MISSING_STATUS: 'missing status',
  UNKNOWN_STATUS: 'unknown status',
});

const MAX_TEXT_LENGTH = 64;
const MARKETPLACES = ['amazon', 'flipkart', 'meesho', 'myntra'];
const STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'];

// The four plain text fields, checked in this order (the order of Section 8).
const TEXT_FIELDS = [
  { field: 'order_id', missing: REASONS.MISSING_ORDER_ID, tooLong: REASONS.ORDER_ID_TOO_LONG },
  { field: 'seller_id', missing: REASONS.MISSING_SELLER_ID, tooLong: REASONS.SELLER_ID_TOO_LONG },
  { field: 'sku', missing: REASONS.MISSING_SKU, tooLong: REASONS.SKU_TOO_LONG },
  { field: 'customer_id', missing: REASONS.MISSING_CUSTOMER_ID, tooLong: REASONS.CUSTOMER_ID_TOO_LONG },
];

// Whole numbers only: digits and nothing else (so no sign, decimal point or exponent).
const WHOLE_NUMBER = /^\d+$/;

// A plain number with 0 to 2 decimals. No minus sign, so negatives fail here too.
const MONEY = /^\d+(\.\d{1,2})?$/;

// ISO 8601: date only, or date + "T" + time, with an optional Z or +hh:mm offset.
// Captures: year, month, day, hour, minute, second, zone.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// Missing columns (undefined/null) and blank values all become '' so one
// "is it empty" check covers them.
function toText(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

// Returns an ISO string, or null if the text is not a real ISO 8601 date.
// JavaScript's own Date parsing is too forgiving on its own: it turns Feb 30
// into Mar 2, reads "1" as a year 2000 date, and reads a time without a zone
// in the server's local zone. So the shape and the calendar are checked first.
function parseIsoDate(text) {
  const match = ISO_DATE.exec(text);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, zone] = match;

  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth) {
    return null;
  }
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59)) {
    return null;
  }

  // A time with no zone is read as UTC, so the result is the same on every machine.
  const withZone = hour !== undefined && zone === undefined ? `${text}Z` : text;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function invalid(reason) {
  return { valid: false, reason };
}

// validateOrderRow(row) -> { valid: true, order } | { valid: false, reason }
// Reports the FIRST rule that fails, in the order of Section 8.
function validateOrderRow(row) {
  const input = row || {};
  const cleaned = {};

  // order_id, seller_id, sku, customer_id: required, trimmed, at most 64 characters.
  for (const { field, missing, tooLong } of TEXT_FIELDS) {
    const text = toText(input[field]);
    if (text === '') {
      return invalid(missing);
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return invalid(tooLong);
    }
    cleaned[field] = text;
  }

  // marketplace: lowercased, one of the four allowed values.
  const marketplace = toText(input.marketplace).toLowerCase();
  if (marketplace === '') {
    return invalid(REASONS.MISSING_MARKETPLACE);
  }
  if (!MARKETPLACES.includes(marketplace)) {
    return invalid(REASONS.UNKNOWN_MARKETPLACE);
  }

  // quantity: a whole number, at least 1.
  const quantityText = toText(input.quantity);
  if (quantityText === '') {
    return invalid(REASONS.MISSING_QUANTITY);
  }
  const quantity = Number(quantityText);
  if (!WHOLE_NUMBER.test(quantityText) || !Number.isSafeInteger(quantity) || quantity < 1) {
    return invalid(REASONS.INVALID_QUANTITY);
  }

  // order_date: must be a real ISO 8601 date.
  const dateText = toText(input.order_date);
  if (dateText === '') {
    return invalid(REASONS.MISSING_ORDER_DATE);
  }
  const orderDate = parseIsoDate(dateText);
  if (orderDate === null) {
    return invalid(REASONS.INVALID_ORDER_DATE);
  }

  // order_amount: a number, at least 0, at most 2 decimal places.
  const amountText = toText(input.order_amount);
  if (amountText === '') {
    return invalid(REASONS.MISSING_ORDER_AMOUNT);
  }
  if (!MONEY.test(amountText)) {
    return invalid(REASONS.INVALID_ORDER_AMOUNT);
  }

  // status: lowercased, one of the six allowed values.
  const status = toText(input.status).toLowerCase();
  if (status === '') {
    return invalid(REASONS.MISSING_STATUS);
  }
  if (!STATUSES.includes(status)) {
    return invalid(REASONS.UNKNOWN_STATUS);
  }

  return {
    valid: true,
    // Same field order as the INSERT in Section 10.
    order: {
      order_id: cleaned.order_id,
      seller_id: cleaned.seller_id,
      marketplace,
      sku: cleaned.sku,
      quantity,
      customer_id: cleaned.customer_id,
      order_date: orderDate,
      order_amount: Number(amountText),
      status,
    },
  };
}

module.exports = { validateOrderRow, REASONS };
