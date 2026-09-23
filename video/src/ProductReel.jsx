import React from 'react';
import {AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, staticFile, Easing} from 'remotion';
import {loadFont as loadHe} from '@remotion/google-fonts/Assistant';
import {loadFont as loadEn} from '@remotion/google-fonts/Figtree';

// Minuto's brand face is Greycliff Hebrew CF (Adobe Fonts, web-kit licence only, so it
// can't be embedded in a render). Figtree is the closest free match to its Latin —
// geometric build, two-storey 'a', tall x-height — and Assistant matches its Hebrew.
const {fontFamily: he} = loadHe('normal', {weights: ['300', '400', '600'], subsets: ['hebrew', 'latin']});
const {fontFamily: en} = loadEn('normal', {weights: ['400', '500', '600'], subsets: ['latin']});

// Quiet, editorial product reel: one warm paper background, brand-matched sans type, a single
// amber hairline, and one line of text at a time under the product. Every fact comes
// from props (scripts/build-facts.mjs or the dashboard); chapters with no data are
// dropped, so the reel gets shorter rather than padded.
export const defaultProductProps = {
  badge: 'מהדורה מוגבלת',
  titleEn: 'Aji Bourbon',
  subtitleEn: 'Anaerobic',
  titleHe: 'קפה אג׳י בורבון אנאירובי',
  notes: ['מנגו', 'פירות טרופיים', 'דבש'],
  detailLine: 'קלייה בהירה',
  originRows: [
    {label: 'חווה', value: 'Las Brisas'},
    {label: 'מגדל', value: 'Brayan Smith'},
    {label: 'עיבוד', value: 'אנאירובי שטוף'},
  ],
  price: 85,
  grams: 180,
  imageUrl: 'https://www.minuto.co.il/content/uploads/2026/09/Minuto_Roastery_brisas.jpg',
  accent: '#B07A3B',
  format: 'reel',   // 'reel' = feed Reel; 'story' = 24h story (tighter safe areas, shorter)
};

const INK = '#2A2520';
const MUTED = '#7A6E61';   // darkened from #8C8176 to clear 3:1 on paper at these sizes
const PAPER = '#F4EFE8';
const FPS = 30;

// A story is watched with a thumb hovering over it and is framed by IG's own chrome:
// the profile row on top and the reply bar at the bottom cover roughly 250px each, so
// story layouts pull inward and run shorter than a feed reel.
const LAYOUT = {
  reel:  {chapter: 110, outro: 90, padTop: 150, padBottom: 190, product: 860},
  story: {chapter: 90,  outro: 60, padTop: 300, padBottom: 330, product: 760},
};
const layoutFor = (p) => LAYOUT[p.format === 'story' ? 'story' : 'reel'];
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const ease = Easing.bezier(0.25, 0.1, 0.25, 1);

const rowValue = (rows, label) => (rows ?? []).find((r) => r.label === label)?.value ?? null;

// Which bottom chapters this product has data for, in order.
const chaptersFor = (p) => {
  const list = ['title'];
  if ((p.notes ?? []).length > 0) list.push('notes');
  if ((p.originRows ?? []).length > 0) list.push('origin');
  if (p.price) list.push('price');
  return list;
};

const totalFrames = (p) => {
  const l = layoutFor(p);
  return chaptersFor(p).length * l.chapter + l.outro;
};

export const calculateProductMetadata = ({props}) => ({
  durationInFrames: totalFrames({...defaultProductProps, ...props}),
  fps: FPS,
});

// Slow fade + drift in, fade out before the next chapter takes over.
const soft = (frame, dur, delay = 0) => {
  const inn = interpolate(frame, [delay, delay + 24], [0, 1], {...clamp, easing: ease});
  const out = interpolate(frame, [dur - 18, dur], [1, 0], {...clamp, easing: ease});
  return {opacity: Math.min(inn, out), transform: `translateY(${interpolate(inn, [0, 1], [14, 0])}px)`};
};

const Product = ({imageUrl, runFrames, width}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30, runFrames - 25, runFrames], [0, 1, 1, 0], {...clamp, easing: ease});
  const scale = interpolate(frame, [0, runFrames], [1.02, 1.09]);
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
      {/* multiply drops the white studio background of product shots into the paper canvas */}
      <Img src={imageUrl} style={{
        width, maxHeight: 1150, objectFit: 'contain', marginTop: -40,
        mixBlendMode: 'multiply', opacity, transform: `scale(${scale})`,
      }} />
    </AbsoluteFill>
  );
};

const TopLabel = ({text, accent, runFrames, padTop}) => {
  const frame = useCurrentFrame();
  const line = interpolate(frame, [18, 60], [0, 1], {...clamp, easing: ease});
  const s = soft(frame, runFrames, 6);
  const latin = /^[\x20-\x7E]+$/.test(text);
  return (
    <AbsoluteFill style={{alignItems: 'center', paddingTop: padTop}}>
      <div style={{
        ...s, color: accent, fontWeight: 500,
        ...(latin
          ? {fontFamily: en, fontSize: 28, fontWeight: 600, letterSpacing: 11}
          : {fontFamily: he, fontSize: 30, fontWeight: 600, letterSpacing: 3, direction: 'rtl'}),
      }}>
        {latin ? text.toUpperCase() : text}
      </div>
      <div style={{width: 160 * line, height: 1.5, background: accent, marginTop: 26, opacity: s.opacity}} />
    </AbsoluteFill>
  );
};

const Bottom = ({padBottom, children}) => (
  <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: padBottom, textAlign: 'center'}}>
    {children}
  </AbsoluteFill>
);

const heLine = (size, color = INK, weight = 300) => ({fontFamily: he, fontSize: size, fontWeight: weight, color, direction: 'rtl', lineHeight: 1.35});

const Chapter = ({kind, p}) => {
  const frame = useCurrentFrame();
  const l = layoutFor(p);
  const s = soft(frame, l.chapter, 4);
  const Bot = ({children}) => <Bottom padBottom={l.padBottom}>{children}</Bottom>;
  if (kind === 'title') {
    return (
      <Bot><div style={s}>
        <div style={{fontFamily: en, fontWeight: 600, fontSize: 100, color: INK, lineHeight: 1.05, letterSpacing: -1, padding: '0 60px'}}>{p.titleEn}</div>
        {p.subtitleEn && <div style={{fontFamily: en, fontWeight: 500, fontSize: 34, color: MUTED, marginTop: 18, letterSpacing: 7, textTransform: 'uppercase'}}>{p.subtitleEn}</div>}
        {p.titleHe && <div style={{...heLine(36, MUTED, 400), marginTop: 22}}>{p.titleHe}</div>}
      </div></Bot>
    );
  }
  if (kind === 'notes') {
    return (
      <Bot><div style={s}>
        <div style={heLine(56, INK, 400)}>{p.notes.slice(0, 3).join(' · ')}</div>
        {p.detailLine && <div style={{...heLine(34, MUTED, 400), marginTop: 18}}>{p.detailLine}</div>}
      </div></Bot>
    );
  }
  if (kind === 'origin') {
    const farm = rowValue(p.originRows, 'חווה');
    const producer = rowValue(p.originRows, 'מגדל');
    const process = rowValue(p.originRows, 'עיבוד');
    // Most products only state a process; promote whatever exists to the headline
    // so this chapter is never a lone muted footnote.
    const headline = farm ?? producer ?? process;
    const sub = headline === process ? null : process;
    const latinHeadline = headline && /^[\x20-\x7E]+$/.test(headline);
    return (
      <Bot><div style={s}>
        {headline && (
          latinHeadline
            ? <div style={{fontFamily: en, fontWeight: 600, fontSize: 72, color: INK, letterSpacing: -0.5}}>{headline}</div>
            : <div style={heLine(54, INK, 400)}>{headline}</div>
        )}
        {farm && producer && (
          <div style={{fontFamily: en, fontWeight: 500, fontSize: 30, color: MUTED, marginTop: 14, letterSpacing: 6, textTransform: 'uppercase'}}>
            {producer}
          </div>
        )}
        {sub && <div style={{...heLine(34, MUTED, 400), marginTop: 16}}>{sub}</div>}
      </div></Bot>
    );
  }
  return (
    <Bot><div style={s}>
      {/* the Hebrew face renders ₪ at the same weight as the numerals; the Latin one does not */}
      <div style={{fontFamily: he, fontWeight: 600, fontSize: 96, color: INK, lineHeight: 1, direction: 'rtl'}}>{p.price} ₪</div>
      {p.grams && <div style={{...heLine(34, MUTED, 400), marginTop: 18}}>{p.grams} גרם</div>}
    </div></Bot>
  );
};

const Outro = ({accent}) => {
  const frame = useCurrentFrame();
  const logo = interpolate(frame, [10, 40], [0, 1], {...clamp, easing: ease});
  const text = interpolate(frame, [26, 56], [0, 1], {...clamp, easing: ease});
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
      <Img src={staticFile('logo.png')} style={{width: 380, mixBlendMode: 'multiply', opacity: logo}} />
      <div style={{width: 120, height: 1.5, background: accent, margin: '34px 0 30px', opacity: text}} />
      <div style={{fontFamily: en, fontWeight: 600, fontSize: 30, letterSpacing: 9, color: INK, opacity: text}}>MINUTO.CO.IL</div>
    </AbsoluteFill>
  );
};

export const ProductReel = (props) => {
  const p = {...defaultProductProps, ...props};
  const accent = p.accent ?? defaultProductProps.accent;
  const l = layoutFor(p);
  const chapters = chaptersFor(p);
  const runFrames = chapters.length * l.chapter;
  return (
    <AbsoluteFill style={{background: `radial-gradient(ellipse at 50% 45%, #FAF7F2 0%, ${PAPER} 60%, #ECE5DB 100%)`}}>
      <Sequence durationInFrames={runFrames}><Product imageUrl={p.imageUrl} runFrames={runFrames} width={l.product} /></Sequence>
      {/* Without a badge the top of the frame would be empty; the wordmark keeps the
          composition anchored and is true of every product. */}
      <Sequence durationInFrames={runFrames}>
        <TopLabel text={p.badge || 'MINUTO'} accent={accent} runFrames={runFrames} padTop={l.padTop} />
      </Sequence>
      {chapters.map((kind, i) => (
        <Sequence key={kind} from={i * l.chapter} durationInFrames={l.chapter}>
          <Chapter kind={kind} p={p} />
        </Sequence>
      ))}
      <Sequence from={runFrames}><Outro accent={accent} /></Sequence>
    </AbsoluteFill>
  );
};
