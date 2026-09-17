import React from 'react';
import {AbsoluteFill, Img, Sequence, spring, interpolate, useCurrentFrame, useVideoConfig, staticFile, Easing} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Heebo';
import {loadFont as loadSerif} from '@remotion/google-fonts/DMSerifDisplay';

const {fontFamily} = loadFont('normal', {weights: ['400', '700', '800'], subsets: ['hebrew', 'latin']});
const {fontFamily: serif} = loadSerif('normal', {weights: ['400'], subsets: ['latin']});

// Every fact on screen comes from props (built by scripts/build-facts.mjs or confirmed in the
// dashboard). Nothing product-specific is hardcoded here.
export const defaultProductProps = {
  badge: 'מהדורה מוגבלת',
  titleEn: 'Aji Bourbon',
  subtitleEn: 'Anaerobic',
  titleHe: 'קפה אג׳י בורבון אנאירובי',
  notes: ['מנגו עסיסי', 'פירות טרופיים', 'רמז לדבש'],
  detailLine: 'קלייה בהירה',
  originRows: [
    {label: 'חווה', value: 'Las Brisas'},
    {label: 'מגדל', value: 'Brayan Smith'},
    {label: 'עיבוד', value: 'אנאירובי שטוף'},
  ],
  price: 85,
  grams: 180,
  imageUrl: 'https://www.minuto.co.il/content/uploads/2026/09/Minuto_Roastery_brisas.jpg',
  accent: '#E8913A',
};

const INK = '#2B2118';
const HONEY = '#D9A441';
const CREAM = '#F7EFE2';
const FPS = 30;
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};

// Scene timing, in frames. Scenes without data are dropped and the reel gets shorter.
const timeline = (props) => {
  const hasOrigin = (props.originRows ?? []).length > 0;
  const intro = 170;
  const origin = hasOrigin ? 100 : 0;
  const price = 90;
  const outro = 60;
  return {intro, origin, price, outro, total: intro + origin + price + outro};
};

export const calculateProductMetadata = ({props}) => ({durationInFrames: timeline(props).total, fps: FPS});

const pop = (frame, fps, delay = 0, damping = 200) => spring({frame: frame - delay, fps, config: {damping}});
const up = (s, px = 50) => ({opacity: s, transform: `translateY(${interpolate(s, [0, 1], [px, 0])}px)`});

const Glow = ({accent}) => {
  const frame = useCurrentFrame();
  const blob = (x, y, r, c, speed, phase) => (
    <div style={{position: 'absolute', left: x + Math.sin(frame / speed + phase) * 40, top: y + Math.cos(frame / speed + phase) * 30,
      width: r, height: r, borderRadius: '50%', background: c, filter: 'blur(90px)', opacity: 0.5}} />
  );
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      {blob(-150, 250, 620, accent, 40, 0)}
      {blob(620, 1100, 700, HONEY, 55, 2)}
    </AbsoluteFill>
  );
};

const Product = ({imageUrl, moveAt}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = pop(frame, fps, 0, 16);
  const float = Math.sin(frame / 22) * 8;
  const move = interpolate(frame, [moveAt, moveAt + 30], [0, 1], {...clamp, easing: Easing.inOut(Easing.cubic)});
  const scale = interpolate(move, [0, 1], [1, 0.62]);
  const y = interpolate(move, [0, 1], [0, -250]);
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', top: 170}}>
      {/* multiply drops the white studio background of product shots into the cream canvas */}
      <Img src={imageUrl} style={{
        width: 900, maxHeight: 1150, objectFit: 'contain', mixBlendMode: 'multiply',
        transform: `translateY(${interpolate(enter, [0, 1], [1000, 0]) + float + y}px) scale(${scale})`,
      }} />
    </AbsoluteFill>
  );
};

const Header = ({badge, titleEn, subtitleEn, titleHe, accent, fadeAt}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const b = pop(frame, fps, 8, 11);
  const out = interpolate(frame, [fadeAt, fadeAt + 18], [1, 0], clamp);
  return (
    <AbsoluteFill style={{alignItems: 'center', paddingTop: 150, fontFamily, opacity: out, textAlign: 'center'}}>
      {badge && (
        <div style={{transform: `scale(${b}) rotate(${interpolate(b, [0, 1], [-10, -3])}deg)`, background: INK, color: CREAM,
          fontSize: 44, fontWeight: 800, padding: '14px 40px', borderRadius: 60, direction: 'rtl'}}>
          {badge}
        </div>
      )}
      <div style={{...up(pop(frame, fps, 18)), fontFamily: serif, fontSize: 104, color: INK, marginTop: 34, lineHeight: 1, padding: '0 60px'}}>{titleEn}</div>
      {subtitleEn && <div style={{...up(pop(frame, fps, 24)), fontFamily: serif, fontSize: 70, color: accent, lineHeight: 1.1}}>{subtitleEn}</div>}
      {titleHe && <div style={{...up(pop(frame, fps, 30)), fontSize: 44, color: INK, fontWeight: 700, direction: 'rtl', marginTop: 10}}>{titleHe}</div>}
    </AbsoluteFill>
  );
};

const Notes = ({notes, detailLine, fadeAt}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const out = interpolate(frame, [fadeAt, fadeAt + 14], [1, 0], clamp);
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 170, direction: 'rtl', fontFamily, opacity: out}}>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22}}>
        {notes.slice(0, 3).map((n, i) => {
          const s = pop(frame, fps, i * 9, 12);
          return (
            <div key={n} style={{transform: `scale(${s})`, opacity: s, background: 'rgba(255,255,255,0.88)', color: INK,
              fontSize: 54, fontWeight: 800, padding: '16px 46px', borderRadius: 100, boxShadow: '0 16px 40px rgba(43,33,24,0.12)'}}>
              {n}
            </div>
          );
        })}
        {detailLine && <div style={{...up(pop(frame, fps, 34)), fontSize: 38, color: INK, marginTop: 8}}>{detailLine}</div>}
      </div>
    </AbsoluteFill>
  );
};

const Origin = ({rows, accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const card = pop(frame, fps, 0, 16);
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 190, direction: 'rtl', fontFamily}}>
      <div style={{transform: `translateY(${interpolate(card, [0, 1], [500, 0])}px)`, width: 860, background: '#fff', borderRadius: 44,
        padding: '34px 56px', boxShadow: '0 30px 80px rgba(43,33,24,0.16)'}}>
        <div style={{fontSize: 36, color: accent, fontWeight: 800, marginBottom: 6}}>תעודת זהות</div>
        {rows.slice(0, 3).map((r, i) => (
          <div key={r.label} style={{...up(pop(frame, fps, 8 + i * 6), 30), display: 'flex', justifyContent: 'space-between', gap: 40,
            padding: '18px 0', borderBottom: '2px solid rgba(43,33,24,0.1)'}}>
            <span style={{color: '#8A7560', fontSize: 40}}>{r.label}</span>
            <span style={{color: INK, fontSize: 44, fontWeight: 800}}>{r.value}</span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Price = ({price, grams, detailLine}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = pop(frame, fps, 0, 14);
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 240, direction: 'rtl', fontFamily}}>
      <div style={{transform: `scale(${s})`, opacity: s, background: INK, borderRadius: 48, padding: '40px 80px',
        display: 'flex', alignItems: 'center', gap: 56, boxShadow: '0 30px 80px rgba(43,33,24,0.3)'}}>
        <div style={{fontSize: 150, fontWeight: 800, color: CREAM}}>₪{price}</div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          {grams && <div style={{fontSize: 54, fontWeight: 800, color: HONEY}}>{grams} גרם</div>}
          {detailLine && <div style={{fontSize: 38, color: CREAM, opacity: 0.85}}>{detailLine}</div>}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Outro = ({accent}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const bg = interpolate(frame, [0, 12], [0, 1], clamp);
  return (
    <AbsoluteFill style={{background: CREAM, opacity: bg, justifyContent: 'center', alignItems: 'center', direction: 'rtl', fontFamily}}>
      <Img src={staticFile('logo.png')} style={{width: 580, mixBlendMode: 'multiply', ...up(pop(frame, fps, 6))}} />
      <div style={{...up(pop(frame, fps, 14)), fontSize: 48, color: INK, fontWeight: 700, marginTop: 10}}>מינוטו קפה בית קלייה ספיישלטי</div>
      <div style={{...up(pop(frame, fps, 22)), fontSize: 46, color: accent, fontWeight: 800, marginTop: 22, direction: 'ltr'}}>minuto.co.il</div>
    </AbsoluteFill>
  );
};

export const ProductReel = (props) => {
  const p = {...defaultProductProps, ...props};
  const t = timeline(p);
  const accent = p.accent ?? defaultProductProps.accent;
  const outroAt = t.intro + t.origin + t.price;
  const notes = p.notes ?? [];
  return (
    <AbsoluteFill style={{background: CREAM, fontFamily}}>
      <Glow accent={accent} />
      <Sequence durationInFrames={outroAt}><Product imageUrl={p.imageUrl} moveAt={t.intro - 30} /></Sequence>
      <Sequence durationInFrames={t.intro}>
        <Header badge={p.badge} titleEn={p.titleEn} subtitleEn={p.subtitleEn} titleHe={p.titleHe} accent={accent} fadeAt={t.intro - 30} />
      </Sequence>
      {notes.length > 0 && (
        <Sequence from={45} durationInFrames={t.intro - 45}><Notes notes={notes} detailLine={p.detailLine} fadeAt={t.intro - 45 - 20} /></Sequence>
      )}
      {t.origin > 0 && <Sequence from={t.intro} durationInFrames={t.origin}><Origin rows={p.originRows} accent={accent} /></Sequence>}
      <Sequence from={t.intro + t.origin} durationInFrames={t.price}><Price price={p.price} grams={p.grams} detailLine={p.detailLine} /></Sequence>
      <Sequence from={outroAt}><Outro accent={accent} /></Sequence>
    </AbsoluteFill>
  );
};
