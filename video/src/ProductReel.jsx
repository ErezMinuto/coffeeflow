import React from 'react';
import {AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, staticFile, Easing} from 'remotion';
import {loadFont as loadHe} from '@remotion/google-fonts/FrankRuhlLibre';
import {loadFont as loadEn} from '@remotion/google-fonts/CormorantGaramond';

const {fontFamily: he} = loadHe('normal', {weights: ['300', '500'], subsets: ['hebrew', 'latin']});
const {fontFamily: en} = loadEn('normal', {weights: ['300', '500'], subsets: ['latin']});
const {fontFamily: enItalic} = loadEn('italic', {weights: ['300'], subsets: ['latin']});

// Quiet, editorial product reel: one warm paper background, serif type, a single
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
};

const INK = '#2A2520';
const MUTED = '#8C8176';
const PAPER = '#F4EFE8';
const FPS = 30;
const CHAPTER = 110;   // frames per bottom chapter
const OUTRO = 90;
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

const totalFrames = (p) => chaptersFor(p).length * CHAPTER + OUTRO;

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

const Product = ({imageUrl, runFrames}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30, runFrames - 25, runFrames], [0, 1, 1, 0], {...clamp, easing: ease});
  const scale = interpolate(frame, [0, runFrames], [1.02, 1.09]);
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
      {/* multiply drops the white studio background of product shots into the paper canvas */}
      <Img src={imageUrl} style={{
        width: 860, maxHeight: 1150, objectFit: 'contain', marginTop: -40,
        mixBlendMode: 'multiply', opacity, transform: `scale(${scale})`,
      }} />
    </AbsoluteFill>
  );
};

const TopLabel = ({text, accent, runFrames}) => {
  const frame = useCurrentFrame();
  const line = interpolate(frame, [18, 60], [0, 1], {...clamp, easing: ease});
  const s = soft(frame, runFrames, 6);
  const latin = /^[\x20-\x7E]+$/.test(text);
  return (
    <AbsoluteFill style={{alignItems: 'center', paddingTop: 150}}>
      <div style={{
        ...s, color: accent, fontWeight: 500,
        ...(latin
          ? {fontFamily: en, fontSize: 30, letterSpacing: 12}
          : {fontFamily: he, fontSize: 34, letterSpacing: 4, direction: 'rtl'}),
      }}>
        {latin ? text.toUpperCase() : text}
      </div>
      <div style={{width: 160 * line, height: 1.5, background: accent, marginTop: 26, opacity: s.opacity}} />
    </AbsoluteFill>
  );
};

const Bottom = ({children}) => (
  <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 190, textAlign: 'center'}}>
    {children}
  </AbsoluteFill>
);

const heLine = (size, color = INK) => ({fontFamily: he, fontSize: size, fontWeight: 300, color, direction: 'rtl', lineHeight: 1.35});

const Chapter = ({kind, p}) => {
  const frame = useCurrentFrame();
  const s = soft(frame, CHAPTER, 4);
  if (kind === 'title') {
    return (
      <Bottom><div style={s}>
        <div style={{fontFamily: en, fontWeight: 300, fontSize: 104, color: INK, lineHeight: 1, padding: '0 60px'}}>{p.titleEn}</div>
        {p.subtitleEn && <div style={{fontFamily: enItalic, fontStyle: 'italic', fontWeight: 300, fontSize: 62, color: MUTED, marginTop: 6}}>{p.subtitleEn}</div>}
        {p.titleHe && <div style={{...heLine(40, MUTED), marginTop: 20}}>{p.titleHe}</div>}
      </div></Bottom>
    );
  }
  if (kind === 'notes') {
    return (
      <Bottom><div style={s}>
        <div style={heLine(64)}>{p.notes.slice(0, 3).join(' · ')}</div>
        {p.detailLine && <div style={{...heLine(38, MUTED), marginTop: 16}}>{p.detailLine}</div>}
      </div></Bottom>
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
      <Bottom><div style={s}>
        {headline && (
          latinHeadline
            ? <div style={{fontFamily: en, fontWeight: 300, fontSize: 72, color: INK}}>{headline}</div>
            : <div style={heLine(64)}>{headline}</div>
        )}
        {farm && producer && (
          <div style={{fontFamily: enItalic, fontStyle: 'italic', fontWeight: 300, fontSize: 46, color: MUTED, marginTop: 2}}>
            by {producer}
          </div>
        )}
        {sub && <div style={{...heLine(38, MUTED), marginTop: 14}}>{sub}</div>}
      </div></Bottom>
    );
  }
  return (
    <Bottom><div style={s}>
      {/* Hebrew serif renders ₪ in the same weight as the numerals; Latin serif does not */}
      <div style={{fontFamily: he, fontWeight: 300, fontSize: 104, color: INK, lineHeight: 1, direction: 'rtl'}}>{p.price} ₪</div>
      {p.grams && <div style={{...heLine(38, MUTED), marginTop: 14}}>{p.grams} גרם</div>}
    </div></Bottom>
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
      <div style={{fontFamily: en, fontWeight: 500, fontSize: 34, letterSpacing: 8, color: INK, opacity: text}}>MINUTO.CO.IL</div>
    </AbsoluteFill>
  );
};

export const ProductReel = (props) => {
  const p = {...defaultProductProps, ...props};
  const accent = p.accent ?? defaultProductProps.accent;
  const chapters = chaptersFor(p);
  const runFrames = chapters.length * CHAPTER;
  return (
    <AbsoluteFill style={{background: `radial-gradient(ellipse at 50% 45%, #FAF7F2 0%, ${PAPER} 60%, #ECE5DB 100%)`}}>
      <Sequence durationInFrames={runFrames}><Product imageUrl={p.imageUrl} runFrames={runFrames} /></Sequence>
      {/* Without a badge the top of the frame would be empty; the wordmark keeps the
          composition anchored and is true of every product. */}
      <Sequence durationInFrames={runFrames}>
        <TopLabel text={p.badge || 'MINUTO'} accent={accent} runFrames={runFrames} />
      </Sequence>
      {chapters.map((kind, i) => (
        <Sequence key={kind} from={i * CHAPTER} durationInFrames={CHAPTER}>
          <Chapter kind={kind} p={p} />
        </Sequence>
      ))}
      <Sequence from={runFrames}><Outro accent={accent} /></Sequence>
    </AbsoluteFill>
  );
};
