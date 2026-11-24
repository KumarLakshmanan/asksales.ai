import { describe, expect, it } from '@jest/globals';
import {
  getMissingContactImportFields,
  validateContactImportIdentifiers,
  contactImportIdentity,
  getMissingContactImportMappings,
} from '../utils/contactImportValidation.js';

describe('contact import validation', () => {
  it('allows a contact without a phone number', () => {
    expect(getMissingContactImportFields({
      email: 'person@example.com',
      company: 'Example Co',
    })).toEqual([]);

    expect(() => validateContactImportIdentifiers('person@example.com', null)).not.toThrow();
  });

  it('accepts a phone-only customer without inventing email or company', () => {
    expect(getMissingContactImportFields({
      email: null,
      company: '',
      phone: '+1 202 555 0199',
    })).toEqual([]);
    expect(() => validateContactImportIdentifiers(null, '+91 98765 43210')).not.toThrow();
    expect(getMissingContactImportMappings({Mobile:'phone'})).toEqual([]);
    expect(getMissingContactImportMappings({Email:'email'})).toEqual([]);
  });

  it('rejects rows and mappings with no usable identifier', () => {
    expect(getMissingContactImportFields({ firstName:'Customer', company:'Company' })).toEqual(['Email or Phone']);
    expect(getMissingContactImportMappings({Name:'firstName',Company:'company'})).toEqual(['Email or Phone']);
    expect(() => validateContactImportIdentifiers('', '')).toThrow('Email or Phone');
  });

  it('uses phone identity even when different customers share an email', () => {
    const a=contactImportIdentity({email:'family@example.test',phone:'+91 98765 43210'});
    const b=contactImportIdentity({email:'family@example.test',phone:'+91 98765 43211'});
    expect(a).toEqual({kind:'phone',value:'919876543210'});
    expect(b).not.toEqual(a);
    expect(contactImportIdentity({email:' FAMILY@EXAMPLE.TEST '})).toEqual({kind:'email',value:'family@example.test'});
  });

  it('does not hide an invalid email just because a phone is present', () => {
    expect(() => validateContactImportIdentifiers('bad-email','+919876543210')).toThrow('Email address is invalid');
  });

  it('validates a phone number when one is supplied', () => {
    expect(() => validateContactImportIdentifiers('person@example.com', 'not-a-phone'))
      .toThrow('Phone number is invalid');
  });
});
