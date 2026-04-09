import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import twilio from "twilio";

const router = Router();

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

// ── Generate Twilio Client token for browser calling ─────────
router.post("/softphone/token", requireAuth, async (req: Request, res: Response) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY || process.env.TWILIO_ACCOUNT_SID;
  const apiSecret = process.env.TWILIO_API_SECRET || process.env.TWILIO_AUTH_TOKEN;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;

  if (!accountSid || !apiSecret) {
    res.status(500).json({ error: "Twilio credentials not configured" });
    return;
  }

  const user = (req as any).user;
  const identity = `user_${user.id}`;

  const token = new AccessToken(accountSid, apiKey!, apiSecret, {
    identity,
    ttl: 3600,
  });

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
  });
  token.addGrant(voiceGrant);

  res.json({
    token: token.toJwt(),
    identity,
    expiresIn: 3600,
  });
});

// ── TwiML for outbound calls from browser ────────────────────
router.post("/softphone/twiml-outbound", (req: Request, res: Response) => {
  const { To } = req.body;
  const callerId = process.env.TWILIO_PHONE_NUMBER;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" record="record-from-answer-dual"
        recordingStatusCallback="/api/voip/webhook/recording"
        recordingStatusCallbackEvent="completed">
    <Number>${To}</Number>
  </Dial>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ── TwiML for incoming calls to browser client ───────────────
router.post("/softphone/twiml-incoming", (req: Request, res: Response) => {
  const { identity } = req.body;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="/api/voip/webhook/recording"
        recordingStatusCallbackEvent="completed">
    <Client>${identity}</Client>
  </Dial>
</Response>`;

  res.type("text/xml").send(twiml);
});

export default router;
