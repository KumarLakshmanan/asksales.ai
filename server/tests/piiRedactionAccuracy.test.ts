import { describe, expect, it, jest } from '@jest/globals';

// PrivacyVaultService imports models/db.js, which connects to Postgres on import.
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn() } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const { redactPiiWithStableTokens, redactSensitiveInboxEmailText } =
  await import('../services/agents/orchestration/PrivacyVaultService.js');

const redact = (text: string) => redactPiiWithStableTokens(text).redactedText;
const unchanged = (text: string) =>
  expect(redactPiiWithStableTokens(text)).toEqual({ redactedText: text, piiTypes: [], tokenCount: 0 });

describe('conversational name redaction', () => {
  it.each([
    'I am looking for a room for 2 nights',
    "I'm travelling with my family next week",
    'I’m travelling with my family next week',
    'This is urgent please help',
    'THIS IS URGENT PLEASE HELP',
    'I AM LOOKING FOR A ROOM',
    'call me back when the room is ready',
    'I am sure this is fine',
    'My name is not on the booking',
    'My name is misspelled on the invoice',
  ])('leaves an ordinary sentence intact: %s', text => unchanged(text));

  it.each([
    ['I am Ravi Kumar and my number is 9876543210', 'I am [NAME_1] and my number is [PHONE_1]'],
    ['my name is ravi', 'my name is [NAME_1]'],
    ['my name is ravi and i need a room', 'my name is [NAME_1] and i need a room'],
    ['My name is Ravi Kumar and I need a room', 'My name is [NAME_1] and I need a room'],
    ['MY NAME IS RAVI AND I NEED A ROOM', 'MY NAME IS [NAME_1] AND I NEED A ROOM'],
    ['My name is Ravi I need a room', 'My name is [NAME_1] I need a room'],
    ['my name is ravi kumar from chennai', 'my name is [NAME_1] from chennai'],
    ['My name is Keerthan P B', 'My name is [NAME_1]'],
    ['My name is Kim So Hyun', 'My name is [NAME_1]'],
    ["my name's ravi, please call", "my name's [NAME_1], please call"],
    ['I am delighted we have a room available. I am Jane Doe.', 'I am delighted we have a room available. I am [NAME_1].'],
    ['I am Jane Doe. This is John Smith. Call me Priya Shah.', 'I am [NAME_1]. This is [NAME_2]. Call me [NAME_3].'],
    ["I'm Priya Shah. Email me at priya@example.com.", "I'm [NAME_1]. Email me at [EMAIL_1]."],
    ['I am sure this is John Smith speaking', 'I am sure this is [NAME_1] speaking'],
    ["This is Sean O'Brien from Dublin", 'This is [NAME_1] from Dublin'],
    ['I am Ravi Kumar From Chennai', 'I am [NAME_1] From Chennai'],
  ])('redacts only the name: %s', (text, expected) => expect(redact(text)).toBe(expected));

  it('replaces exactly the name span and reports it once', () => {
    expect(redactPiiWithStableTokens('my name is ravi and i need a room'))
      .toEqual({ redactedText: 'my name is [NAME_1] and i need a room', piiTypes: ['name'], tokenCount: 1 });
  });

  it('keeps the labelled name pattern untruncated', () => {
    expect(redact('Name: Ravi and Sons Traders\nRooms: 2')).toBe('Name: [NAME_1]\nRooms: 2');
  });

  it('is stable when applied to its own output', () => {
    const once = redact('I am Ravi Kumar and my number is 9876543210. I live at 12 MG Road Bangalore.');
    expect(redact(once)).toBe(once);
  });
});

describe('numeric false positives', () => {
  it.each([
    'Booking reference 123456789 for 3 adults',
    'We are 4 guests arriving 2026 1114',
    'Order #12345678 has not arrived',
    'My booking no. 9876543210 is not showing',
    'Confirmation number is 12345678',
    'Invoice 20261114 is wrong',
    'PNR: 4512345678',
    'Ref. 123456789',
  ])('does not treat a reference or date as an SSN or phone: %s', text => unchanged(text));

  it.each([
    ['My SSN is 123-45-6789', 'My SSN is [SSN_1]'],
    ['SSN 123 45 6789', 'SSN [SSN_1]'],
    ['ssn: 123456789', 'ssn: [SSN_1]'],
    ['My social security number is 123456789', 'My social security number is [SSN_1]'],
    ['9876543210', '[PHONE_1]'],
    ['+91 98765 43210', '[PHONE_1]'],
    ['98765 43210', '[PHONE_1]'],
    ['call me on +91 98765 43210 or mail ravi@example.com', 'call me on [PHONE_1] or mail [EMAIL_1]'],
    ['(415) 555-2671', '[PHONE_1]'],
    ['my number is 9876543210', 'my number is [PHONE_1]'],
    ['phone no. 9876543210', 'phone no. [PHONE_1]'],
    ['My whatsapp id 9876543210', 'My whatsapp id [PHONE_1]'],
    ['For the booking call +91 98765 43210', 'For the booking call [PHONE_1]'],
    ['booking ref +1 415 555 2671', 'booking ref [PHONE_1]'],
  ])('still redacts real identifiers: %s', (text, expected) => expect(redact(text)).toBe(expected));

  it('keeps Luhn-based payment card detection', () => {
    expect(redact('card 4242 4242 4242 4242')).toBe('card [PAYMENT_CARD_1]');
    expect(redactPiiWithStableTokens('Reference 1234 5678 9012 3456 is not a card.').piiTypes).not.toContain('payment_card');
  });
});

describe('name and address disclosures', () => {
  it.each([
    ['Ravi here, need 2 deluxe rooms', '[NAME_1] here, need 2 deluxe rooms'],
    ['Hi, Ravi Kumar here. Need a room', 'Hi, [NAME_1] here. Need a room'],
    ['Hello Ravi here', 'Hello [NAME_1] here'],
    ['Thanks. Priya Shah here from Chennai', 'Thanks. [NAME_1] here from Chennai'],
    ['I live at 12 MG Road Bangalore', 'I live at [ADDRESS_1]'],
    ['I live at 12 M.G. Road, Bangalore. Please send the invoice', 'I live at [ADDRESS_1]. Please send the invoice'],
    ['My address is 221B Baker Street, London', 'My address is [ADDRESS_1]'],
    ['Our address is 15 Lake Road\nThanks', 'Our address is [ADDRESS_1]\nThanks'],
    ['I stay at 4 Anna Nagar and my number is 9876543210', 'I stay at [ADDRESS_1] and my number is [PHONE_1]'],
  ])('redacts: %s', (text, expected) => expect(redact(text)).toBe(expected));

  it.each([
    'Right here',
    'Over here',
    'I am here',
    'Food here is great',
    'Wifi here is slow',
    'right here is fine',
    'I live in Chennai',
    'My address is wrong on the invoice',
    'I stay at your resort next week',
    'I stay at Taj Hotel room 204',
  ])('leaves a non-disclosure intact: %s', text => unchanged(text));

  it('reports the address type and keeps addresses protected in the inbox email projection', () => {
    expect(redactPiiWithStableTokens('I live at 12 MG Road Bangalore').piiTypes).toEqual(['address']);
    const text = 'Ravi here. I live at 12 MG Road Bangalore';
    expect(redactSensitiveInboxEmailText(text, { userId: 7, conversationId: 29 })).toMatch(/^Ravi here\. I live at \[ADDRESS_\d+\]$/);
  });
});
