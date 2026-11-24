import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConnectionGuide } from "@/components/integrations/ConnectionGuide";
import { GmailConnectionGuide, ResendConnectionGuide } from "@/components/integrations/EmailConnectionGuides";
import { InstagramConnectionGuide, FacebookConnectionGuide } from "@/components/integrations/ChannelConnectionGuides";
import { MetaAdsConnectionGuide, GoogleAdsConnectionGuide } from "@/components/integrations/AdsConnectionGuides";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
}));

afterEach(cleanup);

describe("connection guides", () => {
  it("shows guide steps only after opening the side drawer", async () => {
    render(<ConnectionGuideDrawer title="Connect WhatsApp" description="Follow these steps.">
      {close => <><p>Choose your number</p><button onClick={close}>Done</button></>}
    </ConnectionGuideDrawer>);
    expect(screen.queryByText("Choose your number")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "How to connect" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Choose your number")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Choose your number")).not.toBeInTheDocument();
  });
  it("changes WhatsApp instructions with the selected number situation", async () => {
    const connect = vi.fn();
    render(<WhatsAppConnectionGuide onConnect={connect} />);

    expect(screen.getByText("Approve the request on your phone")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full-size WhatsApp Business phone approval example" })).toHaveAttribute("href", "/images/integration-guides/whatsapp-phone-single.png");
    await userEvent.click(screen.getByRole("button", { name: /Connect a new number/ }));
    expect(screen.getByText("Add the number")).toBeInTheDocument();
    expect(screen.queryByText("Approve the request on your phone")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full-size WhatsApp phone number entry example" })).toHaveAttribute("href", "/images/integration-guides/whatsapp-number.png");
    await userEvent.click(screen.getByRole("button", { name: /Connect WhatsApp/ }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it("routes Gmail and Resend guide actions to different setup flows", async () => {
    const connectGmail = vi.fn();
    const openResend = vi.fn();
    render(<><GmailConnectionGuide onConnect={connectGmail} /><ResendConnectionGuide onOpenSetup={openResend} /></>);

    await userEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(connectGmail).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Open full-size Google account chooser example" })).toHaveAttribute("href", "/images/integration-guides/gmail-account-single.png");
    expect(screen.getByRole("link", { name: "Open full-size Resend DNS records and verification example" })).toHaveAttribute("href", "/images/integration-guides/resend-records-single.png");
    await userEvent.click(screen.getByRole("button", { name: "Open sending domains" }));
    expect(openResend).toHaveBeenCalledOnce();
  });

  it("has distinct Instagram and Facebook login guides", () => {
    render(<><InstagramConnectionGuide onConnect={vi.fn()} /><FacebookConnectionGuide onConnect={vi.fn()} /></>);
    expect(screen.getByRole("heading", { name: "Connect your professional Instagram account" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect a Facebook Page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full-size Instagram permissions example" })).toHaveAttribute("href", "/images/integration-guides/instagram-consent-single.png");
  });

  it("shows separate Meta Ads and Google Ads setup requirements", async () => {
    const connectMeta = vi.fn();
    const connectGoogle = vi.fn();
    render(<><MetaAdsConnectionGuide onConnect={connectMeta} /><GoogleAdsConnectionGuide onConnect={connectGoogle} /></>);
    expect(screen.getByText("Choose ad account and Page")).toBeInTheDocument();
    expect(screen.getByText("Choose a customer account")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect Meta Ads" }));
    await userEvent.click(screen.getByRole("button", { name: "Connect Google Ads" }));
    expect(connectMeta).toHaveBeenCalledOnce();
    expect(connectGoogle).toHaveBeenCalledOnce();
  });

  it("does not offer Google sign-in from the guide while Google Ads is not enabled", () => {
    const connectGoogle = vi.fn();
    render(<GoogleAdsConnectionGuide onConnect={connectGoogle} unavailableReason="Google Ads isn't enabled for AskSales yet." />);
    const button = screen.getByRole("button", { name: "Connect Google Ads" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Google Ads isn't enabled for AskSales yet.");
  });
});
