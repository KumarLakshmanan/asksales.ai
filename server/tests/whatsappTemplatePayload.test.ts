import { describe, expect, it } from '@jest/globals';
import { validateWhatsAppTemplateInput } from '../utils/whatsappTemplatePayload.js';

describe('WhatsApp template payload validation', () => {
  it('normalizes a valid editable template payload', () => {
    const result = validateWhatsAppTemplateInput({
      name: ' Appointment_Reminder ',
      language: 'en_US',
      category: 'utility',
      headerType: 'text',
      header: 'Appointment update',
      body: 'Hi {{1}}, your appointment is on {{2}}.',
      examples: { 1: 'Alex', 2: 'Monday at 10:30' },
      footer: 'Reply for help',
      buttons: [{ type: 'URL', text: 'View details', url: 'https://example.com/appointment' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(expect.objectContaining({
      name: 'appointment_reminder',
      category: 'UTILITY',
      headerType: 'TEXT',
      examples: { 1: 'Alex', 2: 'Monday at 10:30' },
    }));
  });

  it('rejects invalid names and incomplete action buttons', () => {
    expect(validateWhatsAppTemplateInput({ name: 'Bad Name!', body: 'Hello' }).error).toMatch(/Name/);
    expect(validateWhatsAppTemplateInput({
      name: 'valid_name',
      body: 'Hello',
      buttons: [{ type: 'URL', text: 'Open' }],
    }).error).toMatch(/valid http/);
  });

  it('limits templates to three valid buttons', () => {
    const buttons = Array.from({ length: 4 }, (_, index) => ({ type: 'QUICK_REPLY', text: `Choice ${index}` }));
    expect(validateWhatsAppTemplateInput({ name: 'choices', body: 'Pick one', buttons }).error).toMatch(/no more than 3/);
  });

  it('rejects malformed or empty variable examples', () => {
    expect(validateWhatsAppTemplateInput({ name: 'bad_examples', body: 'Hi {{1}}', examples: [] }).error).toMatch(/examples.*object/i);
    expect(validateWhatsAppTemplateInput({ name: 'bad_examples', body: 'Hi {{1}}', examples: { 1: ' ' } }).error).toMatch(/example is required/i);
    expect(validateWhatsAppTemplateInput({ name: 'bad_examples', body: 'Hi {{1}}', examples: { customer: 'Alex' } }).error).toMatch(/keys.*positive numbers/i);
  });

  it('preserves media headers and removes stale destinations from other button types', () => {
    const result = validateWhatsAppTemplateInput({
      name: 'product_video',
      body: 'See what is new.',
      headerType: 'VIDEO',
      header: 'This text is stale',
      headerMediaUrl: '4::existing-meta-media-handle',
      buttons: [{ type: 'QUICK_REPLY', text: 'Interested', url: 'https://stale.example.com' }],
    });

    expect(result.data).toEqual(expect.objectContaining({
      header: null,
      headerMediaUrl: '4::existing-meta-media-handle',
      buttons: [{ type: 'QUICK_REPLY', text: 'Interested', url: null, phone_number: null }],
    }));
  });

  it('accepts component-specific examples and keeps duplicate indexes independent', () => {
    const result = validateWhatsAppTemplateInput({
      name: 'component_examples',
      headerType: 'TEXT',
      header: 'Hello {{1}}',
      body: 'Order {{1}} is ready.',
      examples: { 'header:1': 'Customer', 'body:1': 'ORDER-42' },
    });
    expect(result.error).toBeUndefined();
    expect(result.data?.examples).toEqual({ 'header:1': 'Customer', 'body:1': 'ORDER-42' });
  });

  it('rejects invalid variable sequences and missing examples', () => {
    expect(validateWhatsAppTemplateInput({ name: 'gap', body: 'Hello {{2}}', examples: { 2: 'Alex' } }).error)
      .toMatch(/start at \{\{1\}\}/);
    expect(validateWhatsAppTemplateInput({ name: 'named', body: 'Hello {{customer}}' }).error)
      .toMatch(/numbered placeholders/);
    expect(validateWhatsAppTemplateInput({ name: 'missing', body: 'Hello {{1}}' }).error)
      .toMatch(/example for every body variable/);
  });
});

describe('WhatsApp incomplete drafts and authentication', () => {
  const draft = { name: 'draft_message', body: '', headerType:'TEXT', header:'', buttons:[{type:'URL',text:'',url:''}], examples:{'body:1':''} };
  const auth = { name:'verification', category:'AUTHENTICATION', headerType:'NONE', body:'', authConfig:{otpType:'COPY_CODE',buttonText:'Copy code',codeExpirationMinutes:5,addSecurityRecommendation:true} };
  it('allows unfinished content only with the explicit draft option', () => {
    expect(validateWhatsAppTemplateInput(draft, {draftOnly:true}).error).toBeUndefined();
    expect(validateWhatsAppTemplateInput(draft).error).toMatch(/Body is required/);
    expect(validateWhatsAppTemplateInput({...draft, body:'Hello',draftOnly:true}).error).toBeTruthy();
  });
  it('retains safety bounds and structural types on draft saves', () => {
    for (const value of [{...draft,body:'a'.repeat(1025)}, {...draft,body:123}, {...draft,name:'bad name'}, {...draft,buttons:[{type:'INVENTED',text:''}]}, {...draft,examples:[]}]) {
      expect(validateWhatsAppTemplateInput(value,{draftOnly:true}).error).toBeTruthy();
    }
    expect(validateWhatsAppTemplateInput({...draft,buttons:[{type:'URL',text:'',url:'a'.repeat(2049)}]},{draftOnly:true}).error).toMatch(/2048/);
  });
  it('permits numbering gaps in drafts but requires complete ordered examples when submitting', () => {
    const value={name:'draft_variables',body:'Hello {{2}}',examples:{'body:2':''}};
    expect(validateWhatsAppTemplateInput(value,{draftOnly:true}).error).toBeUndefined();
    expect(validateWhatsAppTemplateInput(value).error).toMatch(/without gaps/);
  });
  it('validates and normalizes human-readable variable labels', () => {
    const value={name:'labels',body:'Hello',variableLabels:{'body:1':' Customer name '}};
    expect(validateWhatsAppTemplateInput(value).data?.variableLabels).toEqual({'body:1':'Customer name'});
    expect(validateWhatsAppTemplateInput({...value,variableLabels:{'customer':'Name'}}).error).toMatch(/numbered keys/);
    expect(validateWhatsAppTemplateInput({...value,variableLabels:{'1':'a'.repeat(81)}}).error).toMatch(/80/);
  });
  it('uses authentication settings without demanding an editable body or ordinary example', () => {
    expect(validateWhatsAppTemplateInput(auth).data?.authConfig).toEqual(auth.authConfig);
    expect(validateWhatsAppTemplateInput({...auth,authConfig:null}).error).toMatch(/OTP settings/);
    expect(validateWhatsAppTemplateInput({...auth,headerType:'IMAGE'}).error).toMatch(/preset OTP/);
    expect(validateWhatsAppTemplateInput({...auth,buttons:[{type:'URL',text:'OTP',url:'https://example.com'}]}).error).toMatch(/preset OTP/);
  });
  it('validates one-tap app identity and signature instead of creating a fake URL button', () => {
    const value={...auth,authConfig:{...auth.authConfig,otpType:'ONE_TAP',autofillText:'Autofill',packageName:'com.example.app',signatureHash:'K8a/AINcGX7'}};
    expect(validateWhatsAppTemplateInput(value).error).toBeUndefined();
    for (const config of [{...value.authConfig,packageName:'invalid'}, {...value.authConfig,signatureHash:'short'}, {...value.authConfig,codeExpirationMinutes:91}, {...value.authConfig,buttonText:''}]) {
      expect(validateWhatsAppTemplateInput({...value,authConfig:config}).error).toBeTruthy();
    }
    expect(validateWhatsAppTemplateInput({...value,authConfig:{...value.authConfig,packageName:'',signatureHash:'',autofillText:''}},{draftOnly:true}).error).toBeUndefined();
  });
});
