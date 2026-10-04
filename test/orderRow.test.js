// Unit tests for validateOrderRow (Section 8). Pure logic, so no setup needed.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrderRow, REASONS } = require('../src/validation/orderRow');

// A row that passes every rule. Each test changes only the field it is about.
function validRow(overrides = {}) {
  return {
    order_id: '404-1234567-7654321',
    seller_id: 'S0112',
    marketplace: 'meesho',
    sku: 'KURTI-BLU-M',
    quantity: '2',
    customer_id: 'C00042',
    order_date: '2026-09-28T10:30:00.000Z',
    order_amount: '799.50',
    status: 'delivered',
    ...overrides,
  };
}

// Asserts the row is rejected, and with which reason.
function assertInvalid(overrides, expectedReason) {
  const result = validateOrderRow(validRow(overrides));
  assert.equal(result.valid, false, `expected invalid for ${JSON.stringify(overrides)}`);
  assert.equal(result.reason, expectedReason);
}

describe('valid rows', () => {
  test('a fully valid row returns the cleaned order', () => {
    const result = validateOrderRow(validRow());
    assert.deepEqual(result, {
      valid: true,
      order: {
        order_id: '404-1234567-7654321',
        seller_id: 'S0112',
        marketplace: 'meesho',
        sku: 'KURTI-BLU-M',
        quantity: 2,
        customer_id: 'C00042',
        order_date: '2026-09-28T10:30:00.000Z',
        order_amount: 799.5,
        status: 'delivered',
      },
    });
  });

  test('quantity and order_amount come back as numbers', () => {
    const { order } = validateOrderRow(validRow({ quantity: '3', order_amount: '10' }));
    assert.equal(order.quantity, 3);
    assert.equal(order.order_amount, 10);
  });

  test('whitespace is trimmed from every text field', () => {
    const { valid, order } = validateOrderRow(
      validRow({
        order_id: '  OD1  ',
        seller_id: ' S0001 ',
        sku: ' KURTI-RED-S ',
        customer_id: ' C1 ',
        marketplace: ' amazon ',
        status: ' pending ',
        quantity: ' 4 ',
        order_amount: ' 99.99 ',
      })
    );
    assert.equal(valid, true);
    assert.equal(order.order_id, 'OD1');
    assert.equal(order.seller_id, 'S0001');
    assert.equal(order.sku, 'KURTI-RED-S');
    assert.equal(order.customer_id, 'C1');
    assert.equal(order.marketplace, 'amazon');
    assert.equal(order.status, 'pending');
    assert.equal(order.quantity, 4);
    assert.equal(order.order_amount, 99.99);
  });

  test('uppercase marketplace and status are accepted and lowercased', () => {
    const { valid, order } = validateOrderRow(validRow({ marketplace: 'FLIPKART', status: 'Shipped' }));
    assert.equal(valid, true);
    assert.equal(order.marketplace, 'flipkart');
    assert.equal(order.status, 'shipped');
  });

  test('all four marketplaces and all six statuses are accepted', () => {
    for (const marketplace of ['amazon', 'flipkart', 'meesho', 'myntra']) {
      assert.equal(validateOrderRow(validRow({ marketplace })).valid, true, marketplace);
    }
    for (const status of ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned']) {
      assert.equal(validateOrderRow(validRow({ status })).valid, true, status);
    }
  });

  test('order_amount of 0, a whole number, 1 decimal and 2 decimals are accepted', () => {
    for (const order_amount of ['0', '0.00', '10', '10.5', '10.50']) {
      assert.equal(validateOrderRow(validRow({ order_amount })).valid, true, order_amount);
    }
  });

  test('ids of exactly 64 characters are accepted', () => {
    const sixtyFour = 'A'.repeat(64);
    for (const field of ['order_id', 'seller_id', 'sku', 'customer_id']) {
      assert.equal(validateOrderRow(validRow({ [field]: sixtyFour })).valid, true, field);
    }
  });

  test('order_date is returned as an ISO string', () => {
    // Date only: midnight UTC.
    assert.equal(validateOrderRow(validRow({ order_date: '2026-09-28' })).order.order_date, '2026-09-28T00:00:00.000Z');
    // A time with no zone is read as UTC, so the result does not depend on the machine.
    assert.equal(
      validateOrderRow(validRow({ order_date: '2026-09-28T10:00:00' })).order.order_date,
      '2026-09-28T10:00:00.000Z'
    );
    // An offset is converted to UTC.
    assert.equal(
      validateOrderRow(validRow({ order_date: '2026-09-28T10:00:00+05:30' })).order.order_date,
      '2026-09-28T04:30:00.000Z'
    );
  });

  test('the input row is not changed', () => {
    const row = validRow({ marketplace: ' AMAZON ' });
    const copy = { ...row };
    validateOrderRow(row);
    assert.deepEqual(row, copy);
  });
});

describe('text fields: order_id, seller_id, sku, customer_id', () => {
  const fields = [
    { field: 'order_id', missing: REASONS.MISSING_ORDER_ID, tooLong: REASONS.ORDER_ID_TOO_LONG },
    { field: 'seller_id', missing: REASONS.MISSING_SELLER_ID, tooLong: REASONS.SELLER_ID_TOO_LONG },
    { field: 'sku', missing: REASONS.MISSING_SKU, tooLong: REASONS.SKU_TOO_LONG },
    { field: 'customer_id', missing: REASONS.MISSING_CUSTOMER_ID, tooLong: REASONS.CUSTOMER_ID_TOO_LONG },
  ];

  for (const { field, missing, tooLong } of fields) {
    test(`${field}: empty string is rejected`, () => {
      assertInvalid({ [field]: '' }, missing);
    });

    test(`${field}: whitespace only is rejected`, () => {
      assertInvalid({ [field]: '   ' }, missing);
    });

    test(`${field}: a missing column is rejected`, () => {
      const row = validRow();
      delete row[field];
      const result = validateOrderRow(row);
      assert.deepEqual(result, { valid: false, reason: missing });
    });

    test(`${field}: 65 characters is rejected`, () => {
      assertInvalid({ [field]: 'A'.repeat(65) }, tooLong);
    });
  }

  test('order_id of 65 characters gives "order_id too long"', () => {
    assertInvalid({ order_id: 'X'.repeat(65) }, 'order_id too long');
  });

  test('length is counted after trimming', () => {
    // 64 characters plus surrounding spaces is still fine.
    assert.equal(validateOrderRow(validRow({ order_id: `  ${'A'.repeat(64)}  ` })).valid, true);
  });
});

describe('marketplace', () => {
  test('empty is rejected', () => {
    assertInvalid({ marketplace: '' }, REASONS.MISSING_MARKETPLACE);
  });

  test('an unknown marketplace is rejected', () => {
    assertInvalid({ marketplace: 'ebay' }, REASONS.UNKNOWN_MARKETPLACE);
    assertInvalid({ marketplace: 'amazon.in' }, 'unknown marketplace');
  });
});

describe('quantity', () => {
  test('empty is rejected', () => {
    assertInvalid({ quantity: '' }, REASONS.MISSING_QUANTITY);
  });

  test('0 is rejected', () => {
    assertInvalid({ quantity: '0' }, REASONS.INVALID_QUANTITY);
  });

  test('a negative number is rejected', () => {
    assertInvalid({ quantity: '-1' }, REASONS.INVALID_QUANTITY);
  });

  test('a decimal such as "2.5" is rejected', () => {
    assertInvalid({ quantity: '2.5' }, REASONS.INVALID_QUANTITY);
  });

  test('text such as "abc" is rejected', () => {
    assertInvalid({ quantity: 'abc' }, REASONS.INVALID_QUANTITY);
  });

  test('exponent notation such as "1e3" is rejected', () => {
    assertInvalid({ quantity: '1e3' }, REASONS.INVALID_QUANTITY);
  });

  test('1 is the smallest accepted quantity', () => {
    assert.equal(validateOrderRow(validRow({ quantity: '1' })).valid, true);
  });

  test('2147483647 (the largest PostgreSQL integer) is accepted', () => {
    const result = validateOrderRow(validRow({ quantity: '2147483647' }));
    assert.equal(result.valid, true);
    assert.equal(result.order.quantity, 2147483647);
  });

  test('2147483648 (one above the limit) is rejected as too large', () => {
    assertInvalid({ quantity: '2147483648' }, REASONS.QUANTITY_TOO_LARGE);
    assert.equal(REASONS.QUANTITY_TOO_LARGE, 'quantity too large');
  });

  test('a huge whole number is "too large", not "invalid"', () => {
    assertInvalid({ quantity: '99999999999999999999' }, REASONS.QUANTITY_TOO_LARGE);
    assertInvalid({ quantity: '9'.repeat(400) }, REASONS.QUANTITY_TOO_LARGE);
  });

  test('leading zeros do not change the limit', () => {
    assert.equal(validateOrderRow(validRow({ quantity: '0002147483647' })).valid, true);
    assertInvalid({ quantity: '0002147483648' }, REASONS.QUANTITY_TOO_LARGE);
  });
});

describe('order_date', () => {
  test('empty is rejected', () => {
    assertInvalid({ order_date: '' }, REASONS.MISSING_ORDER_DATE);
  });

  test('"not-a-date" is rejected', () => {
    assertInvalid({ order_date: 'not-a-date' }, REASONS.INVALID_ORDER_DATE);
  });

  test('month 13 is rejected', () => {
    assertInvalid({ order_date: '2026-13-45T10:00:00.000Z' }, REASONS.INVALID_ORDER_DATE);
  });

  test('a day that does not exist (Feb 30) is rejected, not rolled into March', () => {
    assertInvalid({ order_date: '2026-02-30T10:00:00Z' }, REASONS.INVALID_ORDER_DATE);
  });

  test('an impossible time is rejected', () => {
    assertInvalid({ order_date: '2026-09-28T25:00:00Z' }, REASONS.INVALID_ORDER_DATE);
  });

  test('text that is not ISO 8601 is rejected, even if JavaScript could read it', () => {
    assertInvalid({ order_date: '1' }, REASONS.INVALID_ORDER_DATE);
    assertInvalid({ order_date: '28/09/2026' }, REASONS.INVALID_ORDER_DATE);
  });

  test('Feb 29 is accepted in a leap year only', () => {
    assert.equal(validateOrderRow(validRow({ order_date: '2028-02-29T10:00:00Z' })).valid, true);
    assertInvalid({ order_date: '2027-02-29T10:00:00Z' }, REASONS.INVALID_ORDER_DATE);
  });
});

describe('order_amount', () => {
  test('empty is rejected', () => {
    assertInvalid({ order_amount: '' }, REASONS.MISSING_ORDER_AMOUNT);
  });

  test('"-1" is rejected', () => {
    assertInvalid({ order_amount: '-1' }, REASONS.INVALID_ORDER_AMOUNT);
  });

  test('"10.999" (3 decimals) is rejected', () => {
    assertInvalid({ order_amount: '10.999' }, REASONS.INVALID_ORDER_AMOUNT);
  });

  test('"abc" is rejected', () => {
    assertInvalid({ order_amount: 'abc' }, REASONS.INVALID_ORDER_AMOUNT);
  });

  test('a thousands separator such as "1,000" is rejected', () => {
    assertInvalid({ order_amount: '1,000' }, REASONS.INVALID_ORDER_AMOUNT);
  });

  test('9999999999.99 (the largest numeric(12,2) value) is accepted', () => {
    const result = validateOrderRow(validRow({ order_amount: '9999999999.99' }));
    assert.equal(result.valid, true);
    assert.equal(result.order.order_amount, 9999999999.99);
  });

  test('10000000000.00 (one cent above the limit) is rejected as too large', () => {
    assertInvalid({ order_amount: '10000000000.00' }, REASONS.ORDER_AMOUNT_TOO_LARGE);
    assert.equal(REASONS.ORDER_AMOUNT_TOO_LARGE, 'order_amount too large');
  });

  test('10000000000 (no decimals) and a huge amount are rejected as too large', () => {
    assertInvalid({ order_amount: '10000000000' }, REASONS.ORDER_AMOUNT_TOO_LARGE);
    assertInvalid({ order_amount: '9'.repeat(400) }, REASONS.ORDER_AMOUNT_TOO_LARGE);
  });

  test('the format rules still come first: 3 decimals on a huge amount is "invalid"', () => {
    assertInvalid({ order_amount: '99999999999.999' }, REASONS.INVALID_ORDER_AMOUNT);
  });

  test('leading zeros do not change the limit', () => {
    assert.equal(validateOrderRow(validRow({ order_amount: '00009999999999.99' })).valid, true);
    assertInvalid({ order_amount: '00010000000000.00' }, REASONS.ORDER_AMOUNT_TOO_LARGE);
  });
});

describe('status', () => {
  test('empty is rejected', () => {
    assertInvalid({ status: '' }, REASONS.MISSING_STATUS);
  });

  test('an unknown status is rejected', () => {
    assertInvalid({ status: 'shipping' }, REASONS.UNKNOWN_STATUS);
    assertInvalid({ status: 'lost' }, 'unknown status');
  });
});

describe('reporting', () => {
  test('only the FIRST failing rule is reported', () => {
    // order_id comes before seller_id, and seller_id before status.
    assertInvalid({ order_id: '', seller_id: '', status: 'bogus' }, REASONS.MISSING_ORDER_ID);
    assertInvalid({ seller_id: '', status: 'bogus' }, REASONS.MISSING_SELLER_ID);
    // quantity comes before order_amount.
    assertInvalid({ quantity: '0', order_amount: '-5' }, REASONS.INVALID_QUANTITY);
    assertInvalid({ quantity: '2147483648', order_amount: '-5' }, REASONS.QUANTITY_TOO_LARGE);
    assertInvalid({ quantity: '2147483648', order_amount: '10000000000' }, REASONS.QUANTITY_TOO_LARGE);
    // order_amount comes before status.
    assertInvalid({ order_amount: '10000000000', status: 'bogus' }, REASONS.ORDER_AMOUNT_TOO_LARGE);
  });

  test('a missing row (undefined or null) is invalid, not a crash', () => {
    assert.equal(validateOrderRow(undefined).valid, false);
    assert.equal(validateOrderRow(null).valid, false);
  });

  test('every reason string is unique, so summaries can group by reason', () => {
    const reasons = Object.values(REASONS);
    assert.equal(new Set(reasons).size, reasons.length);
  });
});
