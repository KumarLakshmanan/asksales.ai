export type WhatsAppTemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export type WhatsAppAuthConfig = {
  otpType: "COPY_CODE" | "ONE_TAP";
  buttonText: string;
  autofillText?: string;
  packageName?: string;
  signatureHash?: string;
  codeExpirationMinutes: number;
  addSecurityRecommendation: boolean;
};

export type WhatsAppHeaderType = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export type WhatsAppButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
export type WhatsAppTemplateButton = {
  type: WhatsAppButtonType;
  text: string;
  url?: string;
  phone_number?: string;
};
export type WhatsAppDraftButton = WhatsAppTemplateButton & { id: string };

export interface CuratedWhatsAppTemplate {
  id: string;
  name: string;
  title: string;
  category: WhatsAppTemplateCategory;
  feature: string;
  authConfig?: WhatsAppAuthConfig;
  body: string;
  footer?: string;
  buttons?: Array<{ type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER"; text: string }>;
}

export const curatedWhatsAppTemplates: CuratedWhatsAppTemplate[] = [
  {
    id: "account_creation_confirmation",
    name: "account_creation_confirmation",
    title: "Finalize account set-up",
    category: "UTILITY",
    feature: "Account updates",
    body: "Hi {{1}},\n\nYour new account has been created successfully.\n\nPlease verify {{2}} to complete your profile.",
    buttons: [{ type: "URL", text: "Verify account" }],
  },
  {
    id: "address_update",
    name: "address_update",
    title: "Address update",
    category: "UTILITY",
    feature: "Account updates",
    body: "Hi {{1}}, your delivery address has been successfully updated to {{2}}. Contact {{3}} for any inquiries.",
  },
  {
    id: "appointment_cancellation",
    name: "appointment_cancellation",
    title: "Your appointment was canceled",
    category: "UTILITY",
    feature: "Event reminder",
    body: "Hello {{1}},\n\nYour upcoming appointment with {{2}} on {{3}} at {{4}} has been canceled.\n\nLet us know if you have any questions or need to reschedule.",
    buttons: [{ type: "URL", text: "View details" }],
  },
  {
    id: "appointment_confirmed",
    name: "appointment_confirmed",
    title: "Appointment confirmed",
    category: "UTILITY",
    feature: "Event reminder",
    body: "Hi {{1}},\n\nYour appointment is scheduled for {{2}}.\n\nService: {{3}}\nConfirmation number: {{4}}\n\nWe're looking forward to your visit.",
  },
  {
    id: "payment_reminder",
    name: "payment_reminder",
    title: "Upcoming automatic payment",
    category: "UTILITY",
    feature: "Payments",
    body: "Hi {{1}},\n\nYour automatic payment for {{2}} is scheduled on {{3}} for {{4}}.\n\nKindly ensure your balance is sufficient.",
    buttons: [{ type: "URL", text: "View account" }],
  },
  {
    id: "delivery_update",
    name: "delivery_update",
    title: "Your order is on the way",
    category: "UTILITY",
    feature: "Order management",
    body: "Hi {{1}}, your order {{2}} has shipped and is expected to arrive on {{3}}. Track it anytime using the button below.",
    buttons: [{ type: "URL", text: "Track order" }],
  },
  {
    id: "feedback_request",
    name: "feedback_request",
    title: "How did we do?",
    category: "UTILITY",
    feature: "Customer feedback",
    body: "Hi {{1}}, thanks for choosing {{2}}. We'd love to hear about your experience.",
    buttons: [{ type: "URL", text: "Share feedback" }],
  },
  {
    id: "technician_visit",
    name: "technician_visit",
    title: "Technician visit",
    category: "UTILITY",
    feature: "Event reminder",
    body: "Hi {{1}}, we're scheduling a technician visit for your {{2}} on {{3}} between {{4}} and {{5}}. Does this time work?",
    buttons: [{ type: "QUICK_REPLY", text: "Confirm" }, { type: "QUICK_REPLY", text: "Reschedule" }],
  },
  {
    id: "seasonal_offer",
    name: "seasonal_offer",
    title: "A special offer for you",
    category: "MARKETING",
    feature: "Offers",
    body: "Hi {{1}}, enjoy {{2}} off your next order with code {{3}}. This offer ends {{4}}.",
    footer: "Terms apply",
    buttons: [{ type: "URL", text: "Shop now" }],
  },
  {
    id: "new_collection",
    name: "new_collection",
    title: "Our new collection is here",
    category: "MARKETING",
    feature: "Product updates",
    body: "Hey {{1}}! Discover our newest arrivals, selected with you in mind.",
    buttons: [{ type: "URL", text: "Explore collection" }],
  },
  {
    id: "otp_code",
    name: "otp_code",
    title: "Your verification code",
    category: "AUTHENTICATION",
    feature: "Account protection",
    body: "Your verification code is {{1}}. For your security, do not share this code with anyone.",
    footer: "This code expires in 10 minutes",
    authConfig: { otpType: "COPY_CODE", buttonText: "Copy code", codeExpirationMinutes: 10, addSecurityRecommendation: true },
  },
  {
    id: "login_alert",
    name: "login_alert",
    title: "New login detected",
    category: "UTILITY",
    feature: "Account protection",
    body: "We noticed a new login to your account from {{1}} at {{2}}. If this wasn't you, secure your account now.",
    buttons: [{ type: "URL", text: "Secure account" }],
  },
];

export function replaceTemplateVariables(value: string) {
  const samples = ["Alex", "AskSales", "Friday", "10:30 AM", "₹2,499"];
  let index = 0;
  return value.replace(/\{\{[^}]+\}\}/g, () => samples[index++] ?? `value ${index}`);
}
