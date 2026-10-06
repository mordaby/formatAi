// The column classification's name words (owner, 2026-10-06; `config/masking.ts` `columnNames`): Hebrew and English, compared with case,
// spaces, punctuation and geresh / gershayim ignored, word by word.
import { describe, expect, it } from 'vitest';
import { columnNames, nameHolds, normalizeColumnName } from '../src/config/masking';

describe('normalizeColumnName', () => {
  it.each([
    ['ת"ז', 'תז'],
    ['ת״ז', 'תז'],
    ['ת.ז.', 'תז'],
    ["מס' לקוח", 'מס לקוח'],
    ['מס׳ לקוח', 'מס לקוח'],
    ['מס. לקוח', 'מס לקוח'],
    ['דוא"ל', 'דואל'],
    ['סה״כ', 'סהכ'],
    ['  Customer   No. ', 'customer no'],
    ['customer_no', 'customer no'],
    ['CustomerNo', 'customer no'],
    ['customerId', 'customer id'],
    ['Customer #', 'customer no'],
    ['E-mail', 'e mail'],
  ])('%s -> %s', (name, normalized) => {
    expect(normalizeColumnName(name)).toBe(normalized);
  });
});

describe('identifier words', () => {
  it.each([
    'ת.ז', 'ת"ז', 'ת״ז', 'ת.ז.', 'תז', 'תעודת זהות', 'מספר זהות', "מס' לקוח", 'מס׳ לקוח', 'מס. לקוח', 'מספר לקוח', 'מספר הלקוח', 'קוד לקוח',
    'חשבון', 'מספר חשבון', 'טלפון', 'הטלפון', 'נייד', 'מייל', 'אימייל', 'דוא"ל', 'דוא״ל', 'פוליסה', 'מספר פוליסה', 'דרכון',
    'ID', 'Customer ID', 'customerId', 'ID Number', 'Customer No', 'Customer No.', 'CUSTOMER NUMBER', 'customer_no', 'Customer #', 'Account',
    'Account No', 'Phone', 'Mobile Phone', 'Email', 'E-mail', 'eMail', 'Policy', 'Passport', 'IBAN',
  ])('%s is an identifier name', (name) => {
    expect(nameHolds(name, columnNames.identifier)).toBe(true);
  });

  it.each(['Valid', 'Paid', 'Idea', 'Accounting', 'Customer', 'Customers', 'Number', 'מספר', 'מספר פריטים', 'שם לקוח', 'Order No', 'Notes'])(
    '%s is not',
    (name) => {
      expect(nameHolds(name, columnNames.identifier)).toBe(false);
    },
  );
});

describe('measure words', () => {
  it.each(['מחיר', 'מחיר ליחידה', 'סכום', 'סכום כולל', 'סה"כ', 'סה״כ', 'סה"כ לתשלום', 'כמות', 'שיעור', 'עמלה', 'עמלת סוכן', 'עלות', 'יתרת חשבון',
    'Price', 'Unit Price', 'Amount', 'Total', 'Total Amount', 'Qty', 'Quantity', 'Rate', 'Fee', 'Cost', 'Sum', 'Account Balance'])(
    '%s is a measure name',
    (name) => {
      expect(nameHolds(name, columnNames.measure)).toBe(true);
    },
  );

  it.each(['Customer No', 'Pricing Group', 'Totals?', 'מחירון'])('%s is not', (name) => {
    expect(nameHolds(name, columnNames.measure)).toBe(false);
  });
});

describe('person words', () => {
  it.each(['שם', 'שם לקוח', 'שם משפחה', 'איש קשר', 'כתובת', 'Name', 'First Name', 'Customer', 'Contact', 'Address', 'Employee'])('%s is a person name', (name) => {
    expect(nameHolds(name, columnNames.person)).toBe(true);
  });

  it.each(['Status', 'City', 'סטטוס', 'מחלקה'])('%s is not', (name) => {
    expect(nameHolds(name, columnNames.person)).toBe(false);
  });
});
