"use client";

import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, BarChart3, Check, Circle, ContactRound, FileText, Link2, List, MapPin, Pause, Play, ShieldCheck } from "lucide-react";
import { useTheme } from "next-themes";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api";
import { getPasswordChecks, isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { PasswordInput } from "@/components/ui/password-input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import styles from "./ClientAuthPage.module.css";
import { EMAIL_ADDRESS_PATTERN as EMAIL_REGEX } from "../../../../shared/emailAddress";

type Mode = "login" | "register";
type AuthUser = {
  id: number;
  email: string;
  name: string;
  isSetupComplete?: boolean;
  isApproved?: boolean;
  hasBusinessProfile?: boolean;
  businessProfileCount?: number;
  hasBrandToolkit?: boolean;
};

type GoogleCredentialResponse = { credential: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: { client_id: string; callback: (response: GoogleCredentialResponse) => void }) => void;
          renderButton: (element: HTMLElement, options: { theme: string; size: string; text: string; shape: string; width: number }) => void;
        };
      };
    };
  }
}

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID?.trim();
type ChatSender = "customer" | "agent";
type ChatMessage =
  | { from: ChatSender; kind: "text"; text: string; reaction?: string }
  | { from: ChatSender; kind: "image"; caption: string }
  | { from: ChatSender; kind: "voice"; transcript: string; duration: string }
  | { from: ChatSender; kind: "choices"; prompt: string; options: readonly string[] }
  | { from: ChatSender; kind: "list"; prompt: string; options: readonly string[] }
  | { from: ChatSender; kind: "poll"; question: string; options: readonly string[] }
  | { from: ChatSender; kind: "document"; name: string; detail: string }
  | { from: ChatSender; kind: "location"; name: string; address: string }
  | { from: ChatSender; kind: "video"; caption: string; duration: string }
  | { from: ChatSender; kind: "contact"; name: string; detail: string }
  | { from: ChatSender; kind: "sticker"; emoji: string; label: string }
  | { from: ChatSender; kind: "link"; title: string; domain: string; text: string };

const CHAT_EXAMPLES: { label: string; messages: ChatMessage[]; outcome: string }[] = [
  {
    label: "Proposal & next step",
    messages: [
      { from: "customer", kind: "text", text: "Can you send pricing for 50 seats on the Growth plan?" },
      { from: "agent", kind: "text", text: "Yes. Here is the proposal with annual and monthly options." },
      { from: "agent", kind: "document", name: "Growth plan proposal.pdf", detail: "PDF · 1.2 MB" },
      { from: "customer", kind: "text", text: "Thanks. Can we review it with our finance lead on Thursday?" },
      { from: "agent", kind: "choices", prompt: "Choose a next step", options: ["Book a review call", "Send to finance", "Ask a question"] },
    ],
    outcome: "Proposal ready for your review",
  },
  {
    label: "Voice & location",
    messages: [
      { from: "customer", kind: "voice", duration: "0:04", transcript: "We're opening a new store in Bengaluru. Can you visit us this week?" },
      { from: "agent", kind: "text", text: "Absolutely. Please share the store location." },
      { from: "customer", kind: "location", name: "Indiranagar showroom", address: "100 Feet Road, Bengaluru" },
      { from: "agent", kind: "contact", name: "Priya · Sales team", detail: "Your local point of contact" },
    ],
    outcome: "Location and contact captured",
  },
  {
    label: "Lists & documents",
    messages: [
      { from: "customer", kind: "text", text: "Can we move our product demo?" },
      { from: "agent", kind: "list", prompt: "Select a time that works", options: ["Tuesday · 2:00 PM", "Thursday · 11:00 AM", "Friday · 4:00 PM"] },
      { from: "customer", kind: "text", text: "Thursday sounds good. Could you send the deck?" },
      { from: "agent", kind: "document", name: "Product overview.pdf", detail: "PDF · 2.4 MB" },
    ],
    outcome: "Demo details ready for review",
  },
  {
    label: "Photos & reactions",
    messages: [
      { from: "customer", kind: "image", caption: "This is the case I received." },
      { from: "agent", kind: "text", text: "Thanks for the photo. I can help check your order." },
      { from: "customer", kind: "text", text: "Thank you!", reaction: "👍" },
      { from: "agent", kind: "text", text: "I found the details and prepared an update." },
    ],
    outcome: "Support response ready for review",
  },
  {
    label: "Video & links",
    messages: [
      { from: "customer", kind: "text", text: "Can I see how it works before our call?" },
      { from: "agent", kind: "video", caption: "A 30-second product tour", duration: "0:30" },
      { from: "customer", kind: "text", text: "Perfect. Where can my team learn more?" },
      { from: "agent", kind: "link", title: "Explore the product", domain: "asksales.ai", text: "Everything your team needs in one place." },
    ],
    outcome: "Resources ready to share",
  },
  {
    label: "Polls & stickers",
    messages: [
      { from: "customer", kind: "text", text: "Our team is ready to reconnect." },
      { from: "agent", kind: "poll", question: "What should we cover first?", options: ["Pricing", "Integrations", "Live demo"] },
      { from: "customer", kind: "text", text: "Let's start with integrations." },
      { from: "agent", kind: "sticker", emoji: "✨", label: "Great, let's do it!" },
    ],
    outcome: "Follow-up topic ready for review",
  },
];

// A short typing state precedes each example reply; the last step fades the thread before it repeats.
const CHAT_STEP_DELAYS = [1700, 850, 2400, 1500, 850, 2700, 3700, 280] as const;
const CHAT_VISIBLE_COUNTS = [1, 1, 2, 3, 3, 4, 4, 4] as const;

export default function ClientAuthPage({ initialMode }: { initialMode: Mode }) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const { login } = useAuth();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [loginData, setLoginData] = useState({ email: "", password: "" });
  const [registerData, setRegisterData] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [formError, setFormError] = useState("");
  const [nameError, setNameError] = useState("");
  const [googleError, setGoogleError] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [verificationEmailSent, setVerificationEmailSent] = useState(true);
  const [chatExampleIndex, setChatExampleIndex] = useState(0);
  const [chatStep, setChatStep] = useState(0);
  const [chatPaused, setChatPaused] = useState(false);
  const [chatInView, setChatInView] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [selectedDemoOption, setSelectedDemoOption] = useState<string | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement>(null);
  const storyPanelRef = useRef<HTMLElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const manualExampleRef = useRef(false);
  const chatExample = CHAT_EXAMPLES[chatExampleIndex] ?? CHAT_EXAMPLES[0];
  const visibleMessageCount = prefersReducedMotion ? chatExample.messages.length : CHAT_VISIBLE_COUNTS[chatStep];
  const showTyping = !prefersReducedMotion && (chatStep === 1 || chatStep === 4);
  const showOutcome = prefersReducedMotion || chatStep >= 6;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const panel = storyPanelRef.current;
    if (!panel) return;
    const updateVisibility = () => setChatInView(!document.hidden && panel.getClientRects().length > 0);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      setChatInView(entry.isIntersecting && !document.hidden);
    }, { threshold: 0.1 });
    observer?.observe(panel);
    if (!observer) updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!chatInView || prefersReducedMotion || (chatPaused && chatStep !== 7)) return;
    const timeout = window.setTimeout(() => {
      if (chatStep === CHAT_STEP_DELAYS.length - 1) {
        voiceAudioRef.current?.pause();
        setVoicePlaying(false);
        setChatExampleIndex((index) => (index + 1) % CHAT_EXAMPLES.length);
        setChatStep(0);
        setSelectedDemoOption(null);
      } else {
        setChatStep((step) => step + 1);
      }
    }, CHAT_STEP_DELAYS[chatStep]);
    return () => window.clearTimeout(timeout);
  }, [chatExampleIndex, chatInView, chatPaused, chatStep, prefersReducedMotion]);

  useEffect(() => {
    const body = chatBodyRef.current;
    if (!body) return;
    body.scrollTop = manualExampleRef.current || prefersReducedMotion ? 0 : body.scrollHeight;
    manualExampleRef.current = false;
  }, [chatExampleIndex, visibleMessageCount, showTyping, showOutcome, prefersReducedMotion]);

  useEffect(() => {
    void api.get("/api/auth/csrf-token", { skipAuth: true }).catch(() => {});
  }, []);

  const goToWorkspace = useCallback((user: AuthUser) => {
    if (!user.hasBusinessProfile) router.push("/setup/business-profile");
    else if ((user.businessProfileCount || 0) > 1 && user.isApproved) router.push('/dashboard/select-profile');
    else if (!user.hasBrandToolkit || !user.isSetupComplete) router.push("/setup/brand-toolkit");
    else if (!user.isApproved) router.push("/dashboard/approval-pending");
    else {
      let hasPlan = false;
      try { hasPlan = !!sessionStorage.getItem('asksales_subscription_selection'); } catch { /* Optional preference. */ }
      router.push(hasPlan ? "/subscribe" : "/dashboard/home");
    }
  }, [router]);

  const handleGoogleCredential = useCallback(async ({ credential }: GoogleCredentialResponse) => {
    setGoogleError("");
    setIsGoogleSubmitting(true);
    try {
      const data = await api.post<{ user: AuthUser }>("/api/auth/google", { credential }, { skipAuth: true });
      login(data.user);
      toast({ title: "Signed in with Google", description: "Your workspace is ready." });
      goToWorkspace(data.user);
    } catch (error) {
      setGoogleError(error instanceof ApiError && error.status
        ? error.message || "Google sign-in could not be completed."
        : "The server could not be reached. Try again in a moment.");
    } finally {
      setIsGoogleSubmitting(false);
    }
  }, [goToWorkspace, login, toast]);
  const googleCredentialHandlerRef = useRef(handleGoogleCredential);
  useEffect(() => {
    googleCredentialHandlerRef.current = handleGoogleCredential;
  }, [handleGoogleCredential]);

  useEffect(() => {
    const button = googleButtonRef.current;
    if (!GOOGLE_CLIENT_ID || !googleReady || !window.google || !button) return;

    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response) => void googleCredentialHandlerRef.current(response),
    });
    const render = () => {
      button.replaceChildren();
      window.google?.accounts.id.renderButton(button, {
        theme: resolvedTheme === "dark" ? "filled_black" : "outline",
        size: "large",
        text: "continue_with",
        shape: "pill",
        width: Math.min(Math.floor(button.clientWidth), 400),
      });
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(button);
    return () => observer.disconnect();
  }, [googleReady, resolvedTheme]);

  const changeMode = (next: Mode) => {
    setMode(next);
    setNameError("");
    setFormError("");
    setGoogleError("");
    window.history.replaceState(null, "", next === "register" ? "/login?mode=register" : "/login");
  };

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    if (!EMAIL_REGEX.test(loginData.email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }
    setIsSubmitting(true);
    try {
      const data = await api.post<{ user: AuthUser }>("/api/auth/login", loginData, { skipAuth: true });
      login(data.user);
      toast({ title: "Signed in", description: "Your workspace is ready." });
      goToWorkspace(data.user);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        const details = error.data as Record<string, unknown> | undefined;
        if (details?.code === "EMAIL_NOT_VERIFIED") {
          router.push(`/verify-email?email=${encodeURIComponent(loginData.email)}`);
          return;
        }
      }
      setFormError(error instanceof ApiError && error.status
        ? error.message || "The email or password is incorrect."
        : "The server could not be reached. Try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const checks = getPasswordChecks(registerData.password);
  const passwordChecks = [
    { label: "8+ characters, up to 72 bytes", passed: checks.length },
    { label: "Uppercase", passed: checks.uppercase },
    { label: "Lowercase", passed: checks.lowercase },
    { label: "Number", passed: checks.number },
    { label: "Symbol", passed: checks.special },
  ];

  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    setNameError("");
    if (!registerData.name.trim()) {
      setNameError("Enter your full name.");
      document.getElementById("register-name")?.focus();
      return;
    }
    if (!EMAIL_REGEX.test(registerData.email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }
    if (!isStrongPassword(registerData.password)) {
      setFormError(PASSWORD_POLICY_MESSAGE);
      return;
    }
    if (registerData.password !== registerData.confirmPassword) {
      setFormError("Enter the same password in both fields.");
      return;
    }
    setIsSubmitting(true);
    try {
      const email = registerData.email.trim().toLowerCase();
      const result = await api.post<{ verificationEmailSent?: boolean }>("/api/auth/register", {
        name: registerData.name.trim(),
        email,
        password: registerData.password,
      }, { skipAuth: true });
      localStorage.setItem("pendingVerificationEmail", email);
      setVerificationEmail(email);
      setVerificationEmailSent(result.verificationEmailSent !== false);
      if (result.verificationEmailSent === false) {
        toast({ title: "Account created", description: "Request another code on the verification page.", variant: "destructive" });
      }
    } catch (error) {
      setFormError(error instanceof ApiError && error.status
        ? error.message || "Account creation failed."
        : "The server could not be reached. Try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleVoice = () => {
    const audio = voiceAudioRef.current;
    if (!audio) return;
    setChatPaused(true);
    if (audio.paused) {
      void audio.play().then(() => setVoicePlaying(true)).catch(() => setVoicePlaying(false));
    } else {
      audio.pause();
      setVoicePlaying(false);
    }
  };

  const renderChatContent = (message: ChatMessage, index: number) => {
    const selectOption = (option: string) => {
      setSelectedDemoOption(`${chatExampleIndex}:${index}:${option}`);
      setChatPaused(true);
    };
    const isSelected = (option: string) => selectedDemoOption === `${chatExampleIndex}:${index}:${option}`;

    switch (message.kind) {
      case "text":
        return <>{message.text}{message.reaction && <span className={styles.reaction} aria-label={`Reaction: ${message.reaction}`}>{message.reaction}</span>}</>;
      case "image":
        return <div className={styles.mediaMessage}><Image src="/auth/demo-phone-case.svg" width={260} height={136} alt="Ocean blue phone case preview" /><span>{message.caption}</span></div>;
      case "voice":
        return <div className={styles.voiceMessage} aria-label={`Voice note, ${message.duration}. Transcript: ${message.transcript}`}><div className={styles.voiceRow}><button type="button" className={styles.voicePlay} onClick={toggleVoice} aria-label={voicePlaying ? "Pause demo voice note" : "Play demo voice note"}>{voicePlaying ? <Pause size={13} fill="currentColor" aria-hidden="true" /> : <Play size={13} fill="currentColor" aria-hidden="true" />}</button><span className={styles.waveform} aria-hidden="true">{[10, 20, 14, 24, 13, 18, 27, 16, 22, 12, 25, 17, 11, 19, 14, 23, 11, 18].map((height, bar) => <i key={bar} style={{ height }} />)}</span><small>{message.duration}</small></div><span className={styles.voiceTranscript}>{message.transcript}</span></div>;
      case "choices":
      case "list":
        return <div className={styles.interactiveMessage}><div className={styles.messageKicker}>{message.kind === "list" ? <List size={13} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}{message.kind === "list" ? "Select a time" : "Quick replies"}</div><p>{message.prompt}</p><div className={message.kind === "list" ? styles.listOptions : styles.choiceOptions}>{message.options.map((option) => <button key={option} type="button" aria-pressed={isSelected(option)} onClick={() => selectOption(option)}>{message.kind === "list" && <span className={styles.optionRadio} aria-hidden="true" />}{option}{isSelected(option) && <Check size={13} aria-hidden="true" />}</button>)}</div></div>;
      case "poll":
        return <div className={styles.interactiveMessage}><div className={styles.messageKicker}><BarChart3 size={13} aria-hidden="true" />Poll</div><p>{message.question}</p><div className={styles.pollOptions}>{message.options.map((option) => <button key={option} type="button" aria-pressed={isSelected(option)} onClick={() => selectOption(option)}><span className={styles.optionRadio} aria-hidden="true" />{option}{isSelected(option) && <Check size={13} aria-hidden="true" />}</button>)}</div><small>Choose one option</small></div>;
      case "document":
        return <div className={styles.attachmentMessage}><span className={styles.attachmentIcon}><FileText size={21} aria-hidden="true" /></span><span><strong>{message.name}</strong><small>{message.detail}</small></span></div>;
      case "location":
        return <div className={styles.locationMessage}><div className={styles.mapPreview}><MapPin size={24} fill="currentColor" aria-hidden="true" /></div><strong>{message.name}</strong><small>{message.address}</small></div>;
      case "video":
        return <div className={styles.mediaMessage}><div className={styles.videoPreview}><span className={styles.videoPlay}><Play size={18} fill="currentColor" aria-hidden="true" /></span><small>{message.duration}</small></div><span>{message.caption}</span></div>;
      case "contact":
        return <div className={styles.attachmentMessage}><span className={styles.attachmentIcon}><ContactRound size={21} aria-hidden="true" /></span><span><strong>{message.name}</strong><small>{message.detail}</small></span></div>;
      case "sticker":
        return <div className={styles.stickerMessage}><span aria-hidden="true">{message.emoji}</span><small>{message.label}</small></div>;
      case "link":
        return <div className={styles.linkMessage}><span className={styles.attachmentIcon}><Link2 size={19} aria-hidden="true" /></span><span><small>{message.domain}</small><strong>{message.title}</strong><span>{message.text}</span></span></div>;
    }
  };

  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <audio ref={voiceAudioRef} className={styles.demoAudio} src="/auth/demo-voice.m4a" preload="none" onEnded={() => setVoicePlaying(false)} />
      {GOOGLE_CLIENT_ID && (
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onReady={() => setGoogleReady(true)}
          onError={() => setGoogleError("Google sign-in could not load. Please try again later.")}
        />
      )}

      <section className={styles.formPanel} aria-label="Account access">
        <ThemeToggle className={styles.themeToggle} />
        <Link href="/" className={`${styles.brand} ${styles.mobileBrand}`} aria-label="AskSales.AI home">
          <Image src="/logos/asksales_logo.svg" width={36} height={36} alt="" />
          <span>AskSales<span className={styles.brandAccent}>.AI</span></span>
        </Link>
        <div className={styles.formInner}>
          <div className={styles.modeSwitch} role="group" aria-label="Account access mode">
            <button type="button" aria-pressed={mode === "login"} className={mode === "login" ? styles.activeTab : ""} onClick={() => changeMode("login")}>Sign in</button>
            <button type="button" aria-pressed={mode === "register"} className={mode === "register" ? styles.activeTab : ""} onClick={() => changeMode("register")}>Create account</button>
          </div>

          <div className={styles.intro}>
            {mode === "login" ? (
              <><h1>Welcome <span>back.</span></h1><p>Pick up where your customers left off.</p></>
            ) : (
              <><h1>Let&apos;s get <span>started.</span></h1><p>Create your workspace and keep every opportunity moving.</p></>
            )}
          </div>

          {mode === "login" ? (
            <form onSubmit={handleLogin} className={styles.form} noValidate>
              <div className={styles.field}><label htmlFor="login-email">Work email</label><input id="login-email" name="email" type="email" value={loginData.email} onChange={(event) => setLoginData((current) => ({ ...current, email: event.target.value }))} placeholder="you@company.com" autoComplete="email" required /></div>
              <div className={styles.field}><div className={styles.fieldLabelRow}><label htmlFor="login-password">Password</label><Link href="/forgot-password">Forgot?</Link></div><PasswordInput id="login-password" name="password" value={loginData.password} onChange={(event) => setLoginData((current) => ({ ...current, password: event.target.value }))} placeholder="Enter your password" autoComplete="current-password" className={styles.passwordInput} required /></div>
              {formError && <p className={styles.error} role="alert">{formError}</p>}
              <button type="submit" className={styles.submit} disabled={isSubmitting} aria-busy={isSubmitting}>{isSubmitting ? "Signing in…" : "Sign in"}{!isSubmitting && <ArrowRight size={19} aria-hidden="true" />}</button>
              <p className={styles.switchHint}>Don&apos;t have an account? <button type="button" onClick={() => changeMode("register")}>Create one</button></p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className={styles.form} noValidate>
              <div className={styles.field}><label htmlFor="register-name">Full name</label><input id="register-name" name="name" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? "register-name-error" : undefined} value={registerData.name} onChange={(event) => { setRegisterData((current) => ({ ...current, name: event.target.value })); setNameError(""); }} placeholder="Your full name" autoComplete="name" required />{nameError && <p id="register-name-error" className={styles.error} role="alert">{nameError}</p>}</div>
              <div className={styles.field}><label htmlFor="register-email">Work email</label><input id="register-email" name="email" type="email" value={registerData.email} onChange={(event) => setRegisterData((current) => ({ ...current, email: event.target.value }))} placeholder="you@company.com" autoComplete="email" required /></div>
              <div className={styles.field}><label htmlFor="register-password">Password</label><PasswordInput id="register-password" name="password" value={registerData.password} onChange={(event) => setRegisterData((current) => ({ ...current, password: event.target.value }))} placeholder="Create a strong password" autoComplete="new-password" className={styles.passwordInput} aria-describedby="register-password-rules" required /></div>
              {/* Shown before typing so the rules are known up front, not discovered after a failed submit. */}
              <div id="register-password-rules" className={styles.passwordChecks} aria-label="Password requirements">{passwordChecks.map((check) => <span key={check.label} className={check.passed ? styles.passed : ""}>{check.passed ? <Check size={13} aria-hidden="true" /> : <Circle size={11} aria-hidden="true" />}{check.label}{registerData.password ? <span className="sr-only">{check.passed ? " (met)" : " (not met)"}</span> : null}</span>)}</div>
              <div className={styles.field}><label htmlFor="register-confirm">Confirm password</label><PasswordInput id="register-confirm" name="confirmPassword" value={registerData.confirmPassword} onChange={(event) => setRegisterData((current) => ({ ...current, confirmPassword: event.target.value }))} placeholder="Re-enter your password" autoComplete="new-password" className={styles.passwordInput} required /></div>
              {formError && <p className={styles.error} role="alert">{formError}</p>}
              {formError && !isSubmitting && EMAIL_REGEX.test(registerData.email.trim()) && (
                <p className={styles.switchHint}>Already created an account? <Link
                  href={`/verify-email?email=${encodeURIComponent(registerData.email.trim().toLowerCase())}`}
                  className="font-semibold text-primary underline underline-offset-4 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                  Continue email verification
                </Link></p>
              )}
              <button type="submit" className={styles.submit} disabled={isSubmitting} aria-busy={isSubmitting}>{isSubmitting ? "Creating account…" : "Create account"}{!isSubmitting && <ArrowRight size={19} aria-hidden="true" />}</button>
              <p className={styles.switchHint}>Already have an account? <button type="button" onClick={() => changeMode("login")}>Sign in</button></p>
            </form>
          )}

          <div className={styles.divider}><span>or</span></div>
          <div className={`${styles.googleSlot} ${isGoogleSubmitting ? styles.googleBusy : ""}`}>
            {GOOGLE_CLIENT_ID ? <div ref={googleButtonRef} className={styles.googleButton} aria-label="Continue with Google" /> : <p className={styles.googleUnavailable}>Google sign-in is being configured.</p>}
            {isGoogleSubmitting && <span className={styles.googleProgress}>Signing in with Google…</span>}
          </div>
          {googleError && <p className={styles.error} role="alert">{googleError}</p>}

          <nav className={styles.legal} aria-label="Legal">
            <Link href="/privacy">Privacy Policy</Link>
            <span className={styles.legalDot} aria-hidden="true">·</span>
            <Link href="/terms">Terms of Service</Link>
          </nav>
        </div>
      </section>

      <aside ref={storyPanelRef} className={styles.storyPanel} aria-label="AskSales workspace preview">
        <div className={styles.storyGlow} /><div className={styles.storyGrid} />
        <div className={styles.storyContent}>
          <div className={styles.storyHeader}>
            <Link href="/" className={styles.brand} aria-label="AskSales.AI home">
              <Image src="/logos/asksales_logo.svg" width={36} height={36} alt="" />
              <span>AskSales<span className={styles.brandAccent}>.AI</span></span>
            </Link>
            <div className={styles.livePill}><span className={styles.liveDot} />AI assistance for the moments that matter</div>
          </div>
          <h2>Follow every lead.<br /><span>Even after hours.</span></h2>
          <p className={styles.storySubhead}>Your agents keep conversations moving while you stay in control of the decisions.</p>
          <div className={styles.conversation}>
            <div className={styles.conversationHeader}><span className={styles.avatar}>A</span><div><strong>AskSales AI</strong><small><span /> Example conversation</small></div><span className={styles.chatTime}>preview</span></div>
            <div className={styles.exampleOptions} role="group" aria-label="Conversation examples">
              <span className={styles.exampleName}>{chatExample.label}</span>
              <div className={styles.exampleDots}>
                {CHAT_EXAMPLES.map((example, index) => (
                  <button key={example.label} type="button" aria-label={`Show ${example.label} example`} aria-pressed={chatExampleIndex === index} className={chatExampleIndex === index ? styles.selectedExample : ""} onClick={() => { voiceAudioRef.current?.pause(); if (voiceAudioRef.current) voiceAudioRef.current.currentTime = 0; setVoicePlaying(false); manualExampleRef.current = true; setChatExampleIndex(index); setChatStep(6); setChatPaused(true); setSelectedDemoOption(null); }}><span /></button>
                ))}
              </div>
              {!prefersReducedMotion && <button type="button" className={styles.chatPlayback} aria-label={chatPaused ? "Play conversation examples" : "Pause conversation examples"} onClick={() => setChatPaused((paused) => !paused)}>{chatPaused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}</button>}
            </div>
            <div ref={chatBodyRef} className={`${styles.chatBody} ${chatStep === 7 && !prefersReducedMotion ? styles.chatBodyClosing : ""}`} aria-live="off">
              {chatExample.messages.slice(0, visibleMessageCount).map((message, index) => (
                <div key={`${chatExample.label}-${index}`} className={message.from === "customer" ? styles.customerMessage : styles.agentMessage}>{renderChatContent(message, index)}</div>
              ))}
              {showTyping && <div className={`${styles.typingIndicator} ${chatPaused || !chatInView ? styles.typingPaused : ""}`} role="img" aria-label="AskSales AI is typing"><span /><span /><span /></div>}
              {showOutcome && <div className={styles.reviewMessage}><ShieldCheck size={15} aria-hidden="true" />{chatExample.outcome}</div>}
            </div>
          </div>
          <div className={styles.capabilities} aria-label="Workspace capabilities"><div><strong>Capture</strong><span>new opportunities</span></div><div><strong>Qualify</strong><span>with context</span></div><div><strong>Approve</strong><span>before sending</span></div><div><strong>Measure</strong><span>what happened</span></div></div>
        </div>
      </aside>

      <Dialog open={!!verificationEmail}>
        <DialogContent className={`${styles.modal} gap-0 [&>button]:hidden`} style={{ width: "min(calc(100vw - 2rem), 390px)" }}
          onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
          <div className={styles.modalIcon}><Check size={20} aria-hidden="true" /></div>
          <DialogTitle asChild><h2>Check your email</h2></DialogTitle>
          <DialogDescription>{verificationEmailSent ? <>We sent a verification code to <strong>{verificationEmail}</strong>. Enter it to finish creating your workspace.</> : <>Your account was created, but the verification email could not be sent to <strong>{verificationEmail}</strong>. Request another code on the verification page.</>}</DialogDescription>
          <div><button type="button" className={styles.submit} onClick={() => router.push(`/verify-email?email=${encodeURIComponent(verificationEmail)}`)}>Open verification <ArrowRight size={18} aria-hidden="true" /></button></div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
