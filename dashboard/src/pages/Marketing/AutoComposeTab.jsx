import { useState, useRef, useEffect, useMemo } from 'react';
import { callCampaignFunction } from '../../lib/brevo';
import { ProgressBar, useAnimatedProgress } from '../../components/shared/ProgressBar';
import { ACTIVE_DRAFT_KEY, AUTOSAVE_DEBOUNCE_MS, THEME_LABELS } from './constants';
import { AutosaveStatus } from './AutosaveStatus';

export function AutoComposeTab({ data, user, showToast, duplicateData, clearDuplicate, editData, clearEdit, campaignsDb }) {
  const [step, setStep]                 = useState('idle'); // idle | ideas | generating | draft | sending | sent
  const [hint, setHint]                 = useState('');
  const [ideas, setIdeas]               = useState([]);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [draft, setDraft]               = useState(null);
  const [editSubject, setEditSubject]   = useState('');
  const [editBody, setEditBody]         = useState('');
  const [editCtaText, setEditCtaText]   = useState('');
  const [editCtaUrl, setEditCtaUrl]     = useState('');
  const [testEmail, setTestEmail]       = useState('');
  const [syncing, setSyncing]           = useState(false);
  const [showContext, setShowContext]    = useState(false);
  const [editPreheader, setEditPreheader] = useState('');
  const [editGreeting, setEditGreeting]   = useState('');
  const [promoDeadline, setPromoDeadline] = useState('');
  const [saving, setSaving]             = useState(false);
  const [dirty, setDirty]               = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [allProducts, setAllProducts]    = useState([]);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);  // [{email, name}]
  const [sendMode, setSendMode]          = useState('all'); // 'all' | 'selected' | 'group'
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const genProgress   = useAnimatedProgress(step === 'generating', 18);
  const ideasProgress = useAnimatedProgress(ideasLoading, 8);
  const syncProgress  = useAnimatedProgress(syncing, 12);

  const optedInCount = (data.marketingContacts || []).filter(c => c.opted_in).length;

  // Members of any group flagged as is_test_group — deduplicated by email.
  // Powers the one-click "send to test group" button next to the test email input.
  const testGroupMembers = useMemo(() => {
    const testGroupIds = new Set(
      (data.contactGroups || []).filter(g => g.is_test_group).map(g => g.id)
    );
    const byEmail = new Map();
    for (const m of data.contactGroupMembers || []) {
      if (!testGroupIds.has(m.group_id)) continue;
      const email = (m.email || '').toLowerCase().trim();
      if (!email) continue;
      if (!byEmail.has(email)) byEmail.set(email, { email, name: m.name || undefined });
    }
    return Array.from(byEmail.values());
  }, [data.contactGroups, data.contactGroupMembers]);

  // Handle duplicate campaign data arriving from history tab
  useEffect(() => {
    if (!duplicateData) return;
    const loadDuplicate = async () => {
      setStep('generating');
      try {
        // Create a new draft based on the old campaign
        const result = await callCampaignFunction(supabase, 'generate', {
          userId: user.id,
          customInstructions: `שכפול קמפיין קודם. נושא: ${duplicateData.subject}. תוכן: ${duplicateData.message || ''}`,
          duplicateFrom: duplicateData.id,
        });
        if (!result.ok) throw new Error(result.error || 'Duplication failed');
        setDraft(result.campaign);
        setEditSubject(result.campaign.subject);
        setEditBody(result.campaign.body);
        setEditPreheader(result.campaign.preheader || '');
        setEditGreeting(result.campaign.greeting || '');
        setEditCtaText(result.campaign.ctaText || '');
        setEditCtaUrl(result.campaign.ctaUrl || '');
        setDirty(false);
        setStep('draft');
      } catch (err) {
        // Fallback: just load the old data into editor fields
        setEditSubject(duplicateData.subject || '');
        setEditBody(duplicateData.message || '');
        setEditPreheader(duplicateData.preheader || '');
        setEditGreeting('');
        setEditCtaText(duplicateData.cta_text || '');
        setEditCtaUrl(duplicateData.cta_url || '');
        setDraft({
          id: null,
          subject: duplicateData.subject,
          body: duplicateData.message,
          htmlContent: duplicateData.html_content || '',
          ctaText: duplicateData.cta_text || '',
          ctaUrl: duplicateData.cta_url || '',
          products: [],
        });
        setDirty(true);
        setStep('draft');
        showToast('⚠️ שוכפל ללא יצירה מחדש — ערוך ושמור', 'warning');
      }
      clearDuplicate();
    };
    loadDuplicate();
  }, [duplicateData]);

  const getIdeas = async () => {
    setIdeasLoading(true);
    try {
      const result = await callCampaignFunction(supabase, 'generate-ideas', {
        userId: user.id,
        context: hint.trim() || undefined,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to get ideas');
      setIdeas(result.ideas || []);
      setStep('ideas');
    } catch (err) {
      showToast(`❌ שגיאה בקבלת רעיונות: ${err.message}`, 'error');
    } finally {
      setIdeasLoading(false);
    }
  };

  const generateFromIdea = async (idea) => {
    const instructions = `${idea.title}: ${idea.description}`;
    setStep('generating');
    // Pre-load products so we can match suggested names to real woo_products
    let productsToUse = [];
    try {
      const { data: allProds } = await supabase
        .from('woo_products')
        .select('woo_id, name, price, image_url, permalink, regular_price, sale_price, short_description')
        .eq('user_id', user.id)
        .eq('stock_status', 'instock');
      if (allProds && idea.suggestedProducts?.length) {
        // Match suggested product names (fuzzy) to real products
        productsToUse = idea.suggestedProducts.map(suggested => {
          const lower = suggested.toLowerCase();
          return (allProds).find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase().slice(0, 15)));
        }).filter(Boolean);
      }
    } catch (e) { /* ignore, AI will pick products */ }
    try {
      const result = await callCampaignFunction(supabase, 'generate', {
        userId: user.id,
        customInstructions: instructions,
        pinnedProductIds: productsToUse.map(p => p.woo_id),
      });
      if (!result.ok) throw new Error(result.error || 'Generation failed');
      genProgress.complete();
      setDraft(result.campaign);
      setEditSubject(result.campaign.subject);
      setEditBody(result.campaign.body);
      setEditPreheader(result.campaign.preheader || '');
      setEditGreeting(result.campaign.greeting || '');
      setEditCtaText(result.campaign.ctaText || '');
      setEditCtaUrl(result.campaign.ctaUrl || '');
      setDirty(false);
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה ביצירת קמפיין: ${err.message}`, 'error');
      setStep('ideas');
    }
  };

  const generateCampaign = async () => {
    setStep('generating');
    try {
      const result = await callCampaignFunction(supabase, 'generate', {
        userId: user.id,
        customInstructions: hint.trim() || undefined,
      });

      if (!result.ok) throw new Error(result.error || 'Generation failed');
      genProgress.complete();
      setDraft(result.campaign);
      setEditSubject(result.campaign.subject);
      setEditBody(result.campaign.body);
      setEditPreheader(result.campaign.preheader || '');
      setEditGreeting(result.campaign.greeting || '');
      setEditCtaText(result.campaign.ctaText || '');
      setEditCtaUrl(result.campaign.ctaUrl || '');
      setDirty(false);
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה ביצירת קמפיין: ${err.message}`, 'error');
      setStep('idle');
    }
  };

  const regenerate = () => {
    setDraft(null);
    setDirty(false);
    setStep('idle');
    try { localStorage.removeItem(ACTIVE_DRAFT_KEY); } catch {}
  };

  // Fetch products for a campaign row, then populate the editor state in one place.
  // Shared by: history-edit (editData), resume-on-refresh.
  const loadCampaignIntoEditor = async (campaign) => {
    let products = [];
    const ids = (campaign.product_ids || []).map(String);
    if (ids.length) {
      const { data: prods } = await supabase
        .from('woo_products')
        .select('woo_id, name, price, image_url, permalink, regular_price, sale_price, short_description')
        .eq('user_id', user.id)
        .in('woo_id', ids);
      if (prods) {
        // Preserve the original order from product_ids
        const byId = new Map(prods.map(p => [String(p.woo_id), p]));
        products = ids.map(id => byId.get(id)).filter(Boolean);
      }
    }
    setDraft({
      id: campaign.id,
      subject: campaign.subject || '',
      preheader: campaign.preheader || '',
      greeting: '',
      body: campaign.message || '',
      ctaText: campaign.cta_text || '',
      ctaUrl: campaign.cta_url || '',
      htmlContent: campaign.html_content || '',
      products,
      theme: campaign.campaign_type || null,
    });
    setEditSubject(campaign.subject || '');
    setEditBody(campaign.message || '');
    setEditPreheader(campaign.preheader || '');
    setEditGreeting('');
    setEditCtaText(campaign.cta_text || '');
    setEditCtaUrl(campaign.cta_url || '');
    setDirty(false);
    setStep('draft');
  };

  // Load an existing campaign from history directly into the editor (no AI call)
  useEffect(() => {
    if (!editData) return;
    (async () => {
      try {
        await loadCampaignIntoEditor(editData);
      } catch (err) {
        showToast(`❌ שגיאה בטעינת הקמפיין: ${err.message}`, 'error');
      }
      clearEdit();
    })();
  }, [editData]);

  // Resume-on-refresh: on first mount, if there's a remembered draft id,
  // reload it so a page refresh lands the user back in the editor.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    let savedId;
    try { savedId = localStorage.getItem(ACTIVE_DRAFT_KEY); } catch { return; }
    if (!savedId) return;
    (async () => {
      try {
        const { data: campaign, error } = await supabase
          .from('campaigns')
          .select('*')
          .eq('id', Number(savedId))
          .eq('user_id', user.id)
          .eq('status', 'draft')
          .maybeSingle();
        if (error || !campaign) {
          try { localStorage.removeItem(ACTIVE_DRAFT_KEY); } catch {}
          return;
        }
        await loadCampaignIntoEditor(campaign);
      } catch {
        try { localStorage.removeItem(ACTIVE_DRAFT_KEY); } catch {}
      }
    })();
  }, []);

  // Remember the active draft id so refresh can resume the editor.
  useEffect(() => {
    if (!draft?.id) return;
    try { localStorage.setItem(ACTIVE_DRAFT_KEY, String(draft.id)); } catch {}
  }, [draft?.id]);

  // Ref guard against concurrent saves (manual + autosave race).
  const savingLockRef = useRef(false);

  // Save edits — calls update-draft to rebuild HTML with current edits.
  // `isAuto` suppresses the toast for silent autosaves.
  const saveEdits = async (isAuto = false) => {
    if (!draft || !draft.id) return;
    if (savingLockRef.current) {
      // Another save is in flight; mark dirty so the autosave effect re-queues
      // once it finishes.
      if (!isAuto) showToast('⏳ עוד שמירה מתבצעת — נסה שוב בעוד רגע', 'warning');
      return;
    }
    savingLockRef.current = true;
    setSaving(true);
    try {
      const result = await callCampaignFunction(supabase, 'update-draft', {
        userId: user.id,
        campaignId: draft.id,
        subject: editSubject,
        body: editBody,
        preheader: editPreheader,
        greeting: editGreeting,
        // bannerUrl intentionally omitted — backend preserves it from stored HTML
        ctaText: editCtaText,
        ctaUrl: editCtaUrl,
        products: draft.products || [],
        promoDeadline: promoDeadline || null,
      });
      if (result?.htmlContent) {
        setDraft(prev => ({
          ...prev,
          htmlContent: result.htmlContent,
          subject: editSubject,
          body: editBody,
          preheader: editPreheader,
          greeting: editGreeting,
          ctaText: editCtaText,
          ctaUrl: editCtaUrl,
        }));
        setDirty(false);
        setLastSavedAt(Date.now());
        // Re-fetch the shared campaigns cache so the History tab shows
        // the updated subject/body/html_content immediately. Without this,
        // data.campaigns stays stuck on whatever was loaded when the app
        // first mounted, and the history tab shows stale pre-edit content.
        // Fire-and-forget so autosave doesn't block on the network round trip.
        campaignsDb?.refresh?.().catch((e) => console.warn('campaigns refresh failed:', e));
        if (!isAuto) showToast('✅ השינויים נשמרו');
      } else if (result?.error) {
        throw new Error(result.error);
      }
    } catch (err) {
      console.error('saveEdits failed:', err);
      const msg = err?.message || 'שגיאה לא ידועה';
      showToast(`❌ שגיאה בשמירה: ${msg}`, 'error');
    } finally {
      savingLockRef.current = false;
      setSaving(false);
    }
  };

  // Keep a stable ref to the latest saveEdits so the autosave timer
  // always calls the latest closure (with latest state) without being in deps.
  const saveEditsRef = useRef(saveEdits);
  saveEditsRef.current = saveEdits;

  // Debounced autosave — fires AUTOSAVE_DEBOUNCE_MS after the last edit.
  useEffect(() => {
    if (!draft?.id || !dirty || saving) return;
    const timer = setTimeout(() => { saveEditsRef.current(true); }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    dirty,
    saving,
    draft?.id,
    editSubject,
    editBody,
    editPreheader,
    editGreeting,
    editCtaText,
    editCtaUrl,
    promoDeadline,
    draft?.products,
  ]);

  // Mark dirty when any field changes
  const onFieldChange = (setter) => (e) => {
    setter(e.target.value);
    setDirty(true);
  };

  // Fetch all products for the product picker
  const loadAllProducts = async () => {
    try {
      const { data: products } = await supabase
        .from('woo_products')
        .select('woo_id, name, price, image_url, permalink, regular_price, sale_price, short_description')
        .eq('user_id', user.id)
        .eq('stock_status', 'instock')
        .order('name');
      setAllProducts(products || []);
    } catch (err) {
      console.error('Failed to load products:', err);
    }
  };

  const addProduct = (product) => {
    if (!draft) return;
    // Don't add duplicates
    if (draft.products.some(p => p.woo_id === product.woo_id)) return;
    setDraft(prev => ({
      ...prev,
      products: [...(prev.products || []), product],
    }));
    setDirty(true);
  };



  // Use a blob URL for the preview so the iframe shares the parent origin,
  // which avoids CORS issues loading Supabase storage images via srcDoc's opaque origin
  const previewBlobUrl = useMemo(() => {
    const html = draft?.htmlContent || '';
    if (!html) return '';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    return URL.createObjectURL(blob);
  }, [draft?.htmlContent]);

  // Clean up blob URL on unmount or when it changes
  useEffect(() => {
    return () => { if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl); };
  }, [previewBlobUrl]);

  const sendTest = async () => {
    if (!testEmail.trim()) {
      showToast('⚠️ נא להזין כתובת מייל לטסט', 'warning');
      return;
    }
    setStep('sending');
    try {
      const result = await callCampaignFunction(supabase, 'send-test', {
        userId: user.id,
        campaignId: draft.id,
        testEmail: testEmail.trim(),
      });
      // The function returns 200 even when Resend rejected the email —
      // check sent/errors explicitly so the user sees what really happened.
      if (result && result.sent > 0) {
        showToast(`✅ טסט נשלח ל-${testEmail}!`);
      } else {
        const firstErr = Array.isArray(result?.errors) && result.errors.length > 0
          ? result.errors[0]
          : 'Resend rejected the send (no details)';
        console.error('send-test failed:', result);
        showToast(`❌ הטסט לא נשלח: ${firstErr}`, 'error');
      }
      setStep('draft');
    } catch (err) {
      console.error('send-test threw:', err);
      showToast(`❌ שגיאה בשליחת טסט: ${err?.message || 'unknown'}`, 'error');
      setStep('draft');
    }
  };

  const sendCampaign = () => {
    // Recipient count depends on send mode:
    //   all      → every opted-in contact
    //   selected → manually picked contacts
    //   group    → all members of the chosen group (already mirrored into selectedContacts)
    const recipientCount = (sendMode === 'selected' || sendMode === 'group')
      ? selectedContacts.length
      : optedInCount;
    if (recipientCount === 0) {
      const msg = sendMode === 'group'
        ? '⚠️ לא נבחרה קבוצה או שהקבוצה ריקה'
        : sendMode === 'selected'
          ? '⚠️ לא נבחרו נמענים'
          : '⚠️ אין אנשי קשר שאישרו קבלת מיילים';
      showToast(msg, 'warning');
      return;
    }
    setShowSendConfirm(true);
  };

  const executeSend = async () => {
    setShowSendConfirm(false);
    setStep('sending');
    try {
      const payload = {
        userId: user.id,
        campaignId: draft.id,
      };
      // Both 'selected' and 'group' ride the same selectedRecipients backend
      // path — 'group' just pre-populates selectedContacts from a saved group.
      if ((sendMode === 'selected' || sendMode === 'group') && selectedContacts.length > 0) {
        payload.selectedRecipients = selectedContacts;
      }
      const result = await callCampaignFunction(supabase, 'send-campaign', payload);
      showToast(`✅ הקמפיין נשלח ל-${result.sent} נמענים!`);
      setStep('sent');
    } catch (err) {
      showToast(`❌ שגיאה בשליחה: ${err.message}`, 'error');
      setStep('draft');
    }
  };

  // One-click send to every member of every test-flagged group.
  // Uses the same selectedRecipients backend path as manual/group sends.
  const sendToTestGroups = async () => {
    if (!draft?.id) return;
    if (testGroupMembers.length === 0) {
      showToast('⚠️ אין חברים בקבוצות הבדיקה', 'warning');
      return;
    }
    if (!window.confirm(`לשלוח את הקמפיין ל-${testGroupMembers.length} חברי קבוצת הבדיקה?`)) return;
    setStep('sending');
    try {
      const result = await callCampaignFunction(supabase, 'send-campaign', {
        userId: user.id,
        campaignId: draft.id,
        selectedRecipients: testGroupMembers,
        // Test-group sends go to real people but leave the draft editable —
        // backend skips the campaigns.status='sent' update when this is true.
        isTestSend: true,
      });
      if (result && result.sent > 0) {
        showToast(`✅ נשלח ל-${result.sent} חברי קבוצת בדיקה!`);
      } else {
        const firstErr = Array.isArray(result?.errors) && result.errors.length > 0
          ? result.errors[0]
          : 'Resend rejected the send (no details)';
        showToast(`❌ שליחה לקבוצת בדיקה נכשלה: ${firstErr}`, 'error');
      }
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה: ${err?.message || 'unknown'}`, 'error');
      setStep('draft');
    }
  };

  const syncProducts = async () => {
    setSyncing(true);
    try {
      const result = await callCampaignFunction(supabase, 'sync-woo-products', {
        userId: user.id,
      });
      syncProgress.complete();
      showToast(`✅ סונכרנו ${result.synced} מוצרים מ-WooCommerce`);
    } catch (err) {
      showToast(`❌ שגיאה בסנכרון: ${err.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const removeProduct = (wooId) => {
    if (!draft) return;
    setDraft({
      ...draft,
      products: draft.products.filter(p => p.woo_id !== wooId),
    });
    setDirty(true);
  };

  // ── IDLE: Generate button ─────────────────────────────────────────────

  if (step === 'idle') {
    return (
      <div className="section">
        <div style={{
          textAlign: 'center', padding: '40px 20px',
          background: 'linear-gradient(135deg, #F0FDF4, #ECFDF5)',
          borderRadius: '16px', border: '2px solid #BBF7D0',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🤖</div>
          <h2 style={{ color: '#3D4A2E', marginBottom: '8px', fontSize: '1.5rem' }}>
            יצירת קמפיין אוטומטי
          </h2>
          <p style={{ color: '#666', maxWidth: '420px', margin: '0 auto 20px' }}>
            ה-AI ייצור מייל מושלם בעברית עם מוצרים מהחנות שלך.
            <br />רק תאשר ותשלח.
          </p>

          {/* Context / prompt area */}
          <div style={{ maxWidth: '480px', margin: '0 auto 20px', textAlign: 'right' }}>
            <button
              onClick={() => setShowContext(prev => !prev)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#556B3A', fontSize: '0.9rem', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '6px',
                margin: '0 auto 8px', direction: 'rtl',
              }}
            >
              <span style={{ transform: showContext ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'inline-block' }}>◀</span>
              💡 רוצה לכוון את ה-AI? (אופציונלי)
            </button>

            {showContext && (
              <div style={{
                background: 'white', borderRadius: '12px', padding: '16px',
                border: '1px solid #D4E8C2', textAlign: 'right', direction: 'rtl',
              }}>
                <textarea
                  placeholder="ספר ל-AI על מה הקמפיין... למשל הגיע קפה חדש, יש מבצע, תקופת חגים..."
                  value={hint}
                  onChange={e => setHint(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: '8px',
                    border: '1px solid #ddd', fontSize: '0.9rem',
                    fontFamily: 'inherit', resize: 'vertical', direction: 'rtl',
                  }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
                  {[
                    { label: '☀️ קיץ', text: 'תקופת קיץ, קפה קר ומרענן' },
                    { label: '🎄 חגים', text: 'תקופת חגים, מתנות ומבצעים' },
                    { label: '🏷️ מבצע', text: 'מבצע מיוחד באתר, הנחות' },
                    { label: '☕ מוצר חדש', text: 'מוצר חדש שהגיע לחנות' },
                    { label: '🫘 קלייה חדשה', text: 'קלייה חדשה שהגיעה, מקור יחיד' },
                    { label: '🎁 כוסות/אביזרים', text: 'קידום כוסות ואביזרי קפה' },
                  ].map(chip => (
                    <button
                      key={chip.label}
                      onClick={() => setHint(prev => prev ? `${prev}, ${chip.text}` : chip.text)}
                      style={{
                        background: hint.includes(chip.text) ? '#DCFCE7' : '#F5F5F0',
                        border: hint.includes(chip.text) ? '1px solid #86EFAC' : '1px solid #E5E5DB',
                        borderRadius: '20px', padding: '4px 12px', cursor: 'pointer',
                        fontSize: '0.8rem', color: '#3D4A2E', fontWeight: 500,
                        transition: 'all 0.15s',
                      }}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={getIdeas}
              disabled={ideasLoading}
              className="btn-primary"
              style={{ fontSize: '1.1rem', padding: '14px 32px' }}
            >
              {ideasLoading ? '⏳ חושב...' : '💡 תן לי רעיונות'}
            </button>
            <button
              onClick={generateCampaign}
              className="btn-small"
              style={{ fontSize: '0.95rem', padding: '14px 24px' }}
            >
              🚀 צור ישירות
            </button>
          </div>

          <div style={{ marginTop: '16px' }}>
            <button onClick={syncProducts} disabled={syncing} className="btn-small" style={{ fontSize: '0.8rem' }}>
              {syncing ? '⏳ מסנכרן...' : '🔄 סנכרן מוצרים מ-WooCommerce'}
            </button>
          </div>

          <p style={{ color: '#888', fontSize: '0.8rem', marginTop: '16px' }}>
            {optedInCount} נמענים מאושרים
          </p>
        </div>
      </div>
    );
  }

  // ── IDEAS: Pick a concept ──────────────────────────────────────────────

  if (step === 'ideas') {
    const themeIcons = { tips: '💡', story: '📖', promo: '🏷️', seasonal: '🌿', education: '📚' };
    return (
      <div className="section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0 }}>💡 בחר רעיון לקמפיין</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setIdeas([]); setStep('idle'); }} className="btn-small">← חזור</button>
            <button onClick={getIdeas} disabled={ideasLoading} className="btn-small">
              {ideasLoading ? '⏳' : '🔄'} רעיונות חדשים
            </button>
          </div>
        </div>
        {ideasLoading && (
          <div style={{ marginBottom: 16 }}>
            <ProgressBar progress={ideasProgress.progress} label="מחפש רעיונות..." />
          </div>
        )}

        {hint.trim() && (
          <div style={{
            background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px',
            padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem',
            color: '#0369A1', direction: 'rtl',
          }}>
            <strong>ההקשר שלך:</strong> {hint}
          </div>
        )}

        <div style={{ display: 'grid', gap: '12px' }}>
          {ideas.map((idea, i) => (
            <div
              key={i}
              onClick={() => generateFromIdea(idea)}
              style={{
                background: '#FFFFFF', borderRadius: '12px', padding: '20px',
                border: '1px solid #E8E8E0', cursor: 'pointer',
                transition: 'all 0.15s',
                display: 'flex', gap: '16px', alignItems: 'flex-start',
                direction: 'rtl',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#86EFAC'; e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#E8E8E0'; e.currentTarget.style.boxShadow = 'none'; }}
            >
              <div style={{ fontSize: '2rem', lineHeight: 1 }}>
                {themeIcons[idea.theme] || '📧'}
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: '0 0 6px', color: '#2C3522', fontSize: '1.05rem' }}>{idea.title}</h3>
                <p style={{ margin: '0 0 8px', color: '#666', fontSize: '0.9rem', lineHeight: 1.5 }}>{idea.description}</p>
                {idea.suggestedProducts && idea.suggestedProducts.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {idea.suggestedProducts.map((prod, j) => (
                      <span key={j} style={{
                        background: '#F0FDF4', border: '1px solid #BBF7D0',
                        borderRadius: '12px', padding: '2px 10px',
                        fontSize: '0.75rem', color: '#3D4A2E',
                      }}>
                        {prod}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ color: '#556B3A', fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', alignSelf: 'center' }}>
                בחר →
              </div>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <button onClick={generateCampaign} className="btn-small" style={{ fontSize: '0.9rem' }}>
            🚀 או צור קמפיין ישירות בלי לבחור רעיון
          </button>
        </div>
      </div>
    );
  }

  // ── GENERATING: Loading ────────────────────────────────────────────────

  if (step === 'generating') {
    return (
      <div className="section">
        <div style={{ textAlign: 'center', padding: '40px 20px 20px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'spin 2s linear infinite' }}>🤖</div>
          <h2 style={{ color: '#3D4A2E', marginBottom: '6px' }}>יוצר את הקמפיין שלך...</h2>
          <p style={{ color: '#666', marginBottom: '28px' }}>מסנכרן מוצרים, יוצר תוכן בעברית, בונה עיצוב</p>
          <div style={{ maxWidth: 400, margin: '0 auto' }}>
            <ProgressBar progress={genProgress.progress} label="יצירת קמפיין" />
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  // ── SENT: Success ─────────────────────────────────────────────────────

  if (step === 'sent') {
    return (
      <div className="section">
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: '64px', marginBottom: '16px' }}>🎉</div>
          <h2 style={{ color: '#065F46' }}>הקמפיין נשלח בהצלחה!</h2>
          <p style={{ color: '#666', marginBottom: '24px' }}>
            המייל נשלח ל-{optedInCount} נמענים
          </p>
          <button onClick={() => {
            setDraft(null); setStep('idle'); setHint('');
            try { localStorage.removeItem(ACTIVE_DRAFT_KEY); } catch {}
          }} className="btn-primary">
            צור קמפיין חדש
          </button>
        </div>
      </div>
    );
  }

  // ── DRAFT / SENDING: Review & Approve ─────────────────────────────────

  return (
    <div className="section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>📝 עריכת הקמפיין</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {draft?.theme && (
            <span style={{
              background: '#DCFCE7', padding: '4px 12px', borderRadius: '12px',
              fontSize: '0.8rem', fontWeight: 600,
            }}>
              {THEME_LABELS[draft.theme] || draft.theme}
            </span>
          )}
          <AutosaveStatus saving={saving} dirty={dirty} lastSavedAt={lastSavedAt} onSaveNow={() => saveEdits(false)} hasDraftId={!!draft?.id} />
          <button onClick={regenerate} className="btn-small">🔄 צור מחדש</button>
        </div>
      </div>

      <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.7; } }`}</style>

      {/* Banner text — subject + preheader overlay */}
      <div className="form-card" style={{ marginBottom: '12px', background: '#F9F8F5' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>🖼️ טקסט על הבאנר</label>
        <div className="form-group" style={{ marginBottom: '8px' }}>
          <label style={{ fontSize: '0.8rem', color: '#888' }}>כותרת (מופיע על התמונה)</label>
          <input
            type="text"
            value={editSubject}
            onChange={onFieldChange(setEditSubject)}
            style={{ fontSize: '1rem', fontWeight: 600 }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: '0.8rem', color: '#888' }}>תת-כותרת (מופיע מתחת)</label>
          <input
            type="text"
            value={editPreheader}
            onChange={onFieldChange(setEditPreheader)}
            placeholder="משפט קצר שמופיע מתחת לכותרת על הבאנר..."
            style={{ fontSize: '0.9rem' }}
          />
        </div>
      </div>

      {/* Greeting + Body */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <div className="form-group" style={{ marginBottom: '8px' }}>
          <label style={{ fontWeight: 600 }}>פתיחה</label>
          <input
            type="text"
            value={editGreeting}
            onChange={onFieldChange(setEditGreeting)}
            placeholder="היי / שלום / מה קורה"
            style={{ fontSize: '1rem', fontWeight: 600 }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontWeight: 600 }}>תוכן ההודעה</label>
          <textarea
            value={editBody}
            onChange={onFieldChange(setEditBody)}
            rows={6}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', direction: 'rtl' }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, marginTop: '12px' }}>
          <label style={{ fontSize: '0.85rem', color: '#888' }}>📅 תאריך סיום מבצע (אופציונלי — מופיע בתחתית המייל)</label>
          <input
            type="date"
            value={promoDeadline}
            onChange={onFieldChange(setPromoDeadline)}
            style={{ fontSize: '0.9rem', direction: 'ltr', maxWidth: '200px' }}
          />
          {promoDeadline && (
            <p style={{ fontSize: '0.8rem', color: '#556B3A', margin: '4px 0 0', direction: 'rtl' }}>
              יוצג: המבצע עד ה־{new Date(promoDeadline).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })} או עד גמר המלאי, הראשון מבינהם | ט.ל.ח
            </p>
          )}
        </div>
      </div>

      {/* CTA button — text + link */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>🔘 כפתור פעולה (CTA)</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: '1 1 180px', marginBottom: 0 }}>
            <label style={{ fontSize: '0.8rem', color: '#888' }}>טקסט הכפתור</label>
            <input
              type="text"
              value={editCtaText}
              onChange={onFieldChange(setEditCtaText)}
              placeholder="לחנות"
              style={{ fontSize: '0.9rem', direction: 'rtl' }}
            />
          </div>
          <div className="form-group" style={{ flex: '2 1 280px', marginBottom: 0 }}>
            <label style={{ fontSize: '0.8rem', color: '#888' }}>קישור</label>
            <input
              type="url"
              value={editCtaUrl}
              onChange={onFieldChange(setEditCtaUrl)}
              placeholder="https://minuto.co.il/shop"
              style={{ fontSize: '0.9rem', direction: 'ltr', fontFamily: 'monospace' }}
            />
          </div>
        </div>
        <p style={{ fontSize: '0.75rem', color: '#888', margin: '6px 0 0' }}>
          השאר ריק כדי להסתיר את הכפתור. שמור שינויים כדי לעדכן את התצוגה.
        </p>
      </div>

      {/* Products — with add/remove */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '10px' }}>
          מוצרים ({(draft?.products || []).length})
        </label>

        {/* Always-visible product search with autocomplete dropdown */}
        <div style={{ position: 'relative', marginBottom: '12px' }}>
          <input
            type="text"
            value={productSearch}
            onChange={e => { setProductSearch(e.target.value); if (!allProducts.length) loadAllProducts(); }}
            onFocus={() => { if (!allProducts.length) loadAllProducts(); }}
            placeholder="🔍 חפש מוצר להוספה..."
            style={{
              width: '100%', padding: '8px 12px', borderRadius: '8px',
              border: '1px solid #ddd', fontSize: '0.9rem', direction: 'rtl',
              boxSizing: 'border-box',
            }}
          />
          {/* Dropdown — show when search has text OR products loaded and field focused */}
          {productSearch.trim() && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 100,
              background: '#fff', border: '1px solid #E8E8E0', borderRadius: '10px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.1)', maxHeight: '220px', overflowY: 'auto',
            }}>
              {allProducts
                .filter(p => (p.name || '').toLowerCase().includes(productSearch.toLowerCase()))
                .slice(0, 15)
                .map(p => {
                  const alreadyAdded = (draft?.products || []).some(dp => dp.woo_id === p.woo_id);
                  return (
                    <div
                      key={p.woo_id}
                      onClick={() => { if (!alreadyAdded) { addProduct(p); setProductSearch(''); } }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '8px 12px', cursor: alreadyAdded ? 'default' : 'pointer',
                        opacity: alreadyAdded ? 0.5 : 1, direction: 'rtl',
                        borderBottom: '1px solid #F5F5F0',
                      }}
                      onMouseEnter={e => { if (!alreadyAdded) e.currentTarget.style.background = '#F0FDF4'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {p.image_url && (
                        <img src={p.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#3D4A2E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                        {p.price && <div style={{ fontSize: '0.75rem', color: '#888' }}>₪{parseFloat(p.price).toLocaleString()}</div>}
                      </div>
                      {alreadyAdded
                        ? <span style={{ fontSize: '0.75rem', color: '#10B981', flexShrink: 0 }}>✓ נוסף</span>
                        : <span style={{ fontSize: '0.8rem', color: '#556B3A', flexShrink: 0 }}>➕</span>
                      }
                    </div>
                  );
                })}
              {allProducts.filter(p => (p.name || '').toLowerCase().includes(productSearch.toLowerCase())).length === 0 && (
                <div style={{ padding: '12px', color: '#999', fontSize: '0.85rem', textAlign: 'center' }}>לא נמצאו מוצרים</div>
              )}
            </div>
          )}
        </div>

        {/* Current products */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {(draft?.products || []).map(p => (
            <div key={p.woo_id} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: '#F0FDF4', border: '1px solid #BBF7D0',
              borderRadius: '8px', padding: '6px 10px',
            }}>
              {p.image_url && (
                <img src={p.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }} />
              )}
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#3D4A2E' }}>{p.name}</div>
                {p.price && <div style={{ fontSize: '0.75rem', color: '#556B3A' }}>₪{p.price}</div>}
              </div>
              <button
                onClick={() => removeProduct(p.woo_id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: '1rem', color: '#999', padding: '0 4px',
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {(draft?.products || []).length === 0 && (
            <div style={{ color: '#999', fontSize: '0.85rem', fontStyle: 'italic' }}>אין מוצרים. לחץ "הוסף מוצר" למעלה.</div>
          )}
        </div>
      </div>

      {/* Preview updates automatically after autosave. No banner needed. */}

      <div className="form-card" style={{ marginBottom: '12px' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>👁️ תצוגה מקדימה</label>
        <iframe
          src={previewBlobUrl || 'about:blank'}
          style={{ width: '100%', height: '600px', border: '1px solid #ddd', borderRadius: '8px' }}
          title="Email Preview"
        />
      </div>

      {/* Actions */}
      <div className="form-card">
        {/* Test send */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <input
            type="email"
            placeholder="מייל לטסט (שלך)"
            value={testEmail}
            onChange={e => setTestEmail(e.target.value)}
            style={{ flex: '1 1 200px', fontFamily: 'monospace', fontSize: '0.9rem' }}
          />
          <button
            onClick={sendTest}
            disabled={step === 'sending'}
            className="btn-small"
            style={{ whiteSpace: 'nowrap' }}
          >
            {step === 'sending' ? '⏳' : '📧'} שלח טסט
          </button>
          {/* One-click: send draft to every member of every test-flagged group */}
          {testGroupMembers.length > 0 && (
            <button
              onClick={sendToTestGroups}
              disabled={step === 'sending'}
              className="btn-small"
              style={{ whiteSpace: 'nowrap', background: '#FEF3C7', borderColor: '#FDE68A', color: '#92400E' }}
              title={`שליחה לקבוצות הבדיקה (${testGroupMembers.length} נמענים)`}
            >
              🧪 שלח לקבוצת בדיקה ({testGroupMembers.length})
            </button>
          )}
        </div>

        {/* Send mode toggle */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px', fontSize: '0.9rem' }}>📬 שלח אל:</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => { setSendMode('all'); setShowContactPicker(false); setSelectedGroupId(null); }}
              className={sendMode === 'all' ? 'btn-primary' : 'btn-small'}
              style={{ fontSize: '0.85rem', padding: '6px 16px' }}
            >
              כל הנמענים ({optedInCount})
            </button>
            <button
              onClick={() => { setSendMode('group'); setShowContactPicker(false); }}
              className={sendMode === 'group' ? 'btn-primary' : 'btn-small'}
              style={{ fontSize: '0.85rem', padding: '6px 16px' }}
            >
              קבוצה {selectedGroupId ? `(${selectedContacts.length})` : ''}
            </button>
            <button
              onClick={() => { setSendMode('selected'); setShowContactPicker(true); setSelectedGroupId(null); }}
              className={sendMode === 'selected' ? 'btn-primary' : 'btn-small'}
              style={{ fontSize: '0.85rem', padding: '6px 16px' }}
            >
              בחירה ידנית {sendMode === 'selected' && selectedContacts.length > 0 ? `(${selectedContacts.length})` : ''}
            </button>
          </div>
        </div>

        {/* Group picker */}
        {sendMode === 'group' && (
          <div style={{
            border: '1px solid #D4E8C2', borderRadius: '10px', padding: '12px',
            marginBottom: '12px', background: '#FAFFF5',
          }}>
            {(data.contactGroups || []).length === 0 ? (
              <div style={{ color: '#888', fontSize: '0.85rem', textAlign: 'center', padding: '8px' }}>
                אין קבוצות עדיין. צור קבוצה בלשונית "קבוצות" מעל.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {(data.contactGroups || []).map(g => {
                  const count = (data.contactGroupMembers || []).filter(m => m.group_id === g.id).length;
                  const isSelected = selectedGroupId === g.id;
                  return (
                    <label
                      key={g.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                        borderRadius: '8px', cursor: 'pointer', direction: 'rtl',
                        background: isSelected ? '#F0FDF4' : '#FFFFFF',
                        border: isSelected ? '1px solid #86EFAC' : '1px solid #E8E8E0',
                      }}
                    >
                      <input
                        type="radio"
                        name="group-pick"
                        checked={isSelected}
                        onChange={() => {
                          setSelectedGroupId(g.id);
                          const members = (data.contactGroupMembers || [])
                            .filter(m => m.group_id === g.id)
                            .map(m => ({ email: m.email, name: m.name || undefined }));
                          setSelectedContacts(members);
                        }}
                        style={{ accentColor: '#3D4A2E' }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#2C3522' }}>{g.name}</span>
                        {g.is_test_group && (
                          <span style={{
                            marginRight: '6px', background: '#FEF3C7', color: '#92400E',
                            border: '1px solid #FDE68A', borderRadius: '10px', padding: '1px 8px',
                            fontSize: '0.7rem', fontWeight: 600,
                          }}>🧪 בדיקה</span>
                        )}
                        <div style={{ fontSize: '0.75rem', color: '#888' }}>
                          {count} חברים {g.description ? `• ${g.description}` : ''}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Contact picker */}
        {showContactPicker && (
          <div style={{
            border: '1px solid #D4E8C2', borderRadius: '10px', padding: '12px',
            marginBottom: '12px', background: '#FAFFF5', maxHeight: '300px', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <input
              type="text"
              placeholder="🔍 חפש לפי שם או אימייל..."
              value={contactSearch}
              onChange={e => setContactSearch(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: '8px',
                border: '1px solid #ddd', fontSize: '0.85rem', marginBottom: '8px',
                direction: 'rtl',
              }}
            />
            {selectedContacts.length > 0 && (
              <div style={{ marginBottom: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {selectedContacts.map(c => (
                  <span key={c.email} style={{
                    background: '#DCFCE7', border: '1px solid #86EFAC', borderRadius: '16px',
                    padding: '2px 10px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '4px',
                  }}>
                    {c.name || c.email}
                    <button
                      onClick={() => setSelectedContacts(prev => prev.filter(s => s.email !== c.email))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: '#666', padding: 0 }}
                    >✕</button>
                  </span>
                ))}
                <button
                  onClick={() => setSelectedContacts([])}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: '#999' }}
                >נקה הכל</button>
              </div>
            )}
            <div style={{ overflowY: 'auto', maxHeight: '200px' }}>
              {(data.marketingContacts || [])
                .filter(c => c.opted_in)
                .filter(c => {
                  if (!contactSearch.trim()) return true;
                  const q = contactSearch.toLowerCase();
                  return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
                })
                .slice(0, 50)
                .map(c => {
                  const isSelected = selectedContacts.some(s => s.email === c.email);
                  return (
                    <label key={c.id} style={{
                      display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
                      borderRadius: '6px', cursor: 'pointer', direction: 'rtl',
                      background: isSelected ? '#F0FDF4' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#F5F5F0'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          if (isSelected) {
                            setSelectedContacts(prev => prev.filter(s => s.email !== c.email));
                          } else {
                            setSelectedContacts(prev => [...prev, { email: c.email, name: c.name }]);
                          }
                        }}
                        style={{ accentColor: '#3D4A2E' }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#2C3522' }}>{c.name || '—'}</span>
                        <span style={{ fontSize: '0.8rem', color: '#888', marginRight: '8px', fontFamily: 'monospace' }}>{c.email}</span>
                      </div>
                    </label>
                  );
                })}
            </div>
          </div>
        )}

        {/* Approve & Send */}
        <button
          onClick={sendCampaign}
          disabled={step === 'sending' || (sendMode === 'all' ? optedInCount === 0 : selectedContacts.length === 0)}
          className="btn-primary"
          style={{ width: '100%', fontSize: '1.1rem', padding: '14px' }}
        >
          {step === 'sending'
            ? '⏳ שולח...'
            : sendMode === 'group'
              ? `✅ שלח לקבוצה (${selectedContacts.length} חברים)`
              : sendMode === 'selected'
                ? `✅ שלח ל-${selectedContacts.length} נמענים שנבחרו`
                : `✅ אשר ושלח ל-${optedInCount} נמענים`
          }
        </button>
      </div>

      {/* ── Send Confirmation Modal ─────────────────────────────────────────── */}
      {showSendConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px',
        }}>
          <div style={{
            background: '#fff', borderRadius: '16px', padding: '28px',
            maxWidth: '440px', width: '100%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            direction: 'rtl',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
              <span style={{ fontSize: '1.8rem' }}>📤</span>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: '#1a1a1a' }}>
                אישור שליחת קמפיין
              </h3>
            </div>

            {/* What */}
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
              <p style={{ margin: '0 0 4px', fontSize: '0.78rem', fontWeight: 600, color: '#166534', textTransform: 'uppercase', letterSpacing: '0.5px' }}>נושא המייל</p>
              <p style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#14532D' }}>
                {editSubject || draft?.subject || '—'}
              </p>
            </div>

            {/* To whom */}
            <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '10px', padding: '14px', marginBottom: '20px' }}>
              <p style={{ margin: '0 0 6px', fontSize: '0.78rem', fontWeight: 600, color: '#1E40AF', textTransform: 'uppercase', letterSpacing: '0.5px' }}>נמענים</p>
              {sendMode === 'all' ? (
                <p style={{ margin: 0, fontSize: '1rem', color: '#1E3A8A' }}>
                  <strong>{optedInCount}</strong> אנשי קשר שאישרו קבלת מיילים
                </p>
              ) : (
                <>
                  <p style={{ margin: '0 0 8px', fontSize: '1rem', color: '#1E3A8A' }}>
                    <strong>{selectedContacts.length}</strong>
                    {sendMode === 'group'
                      ? ` חברים בקבוצה "${(data.contactGroups || []).find(g => g.id === selectedGroupId)?.name || ''}"`
                      : ' נמענים שנבחרו ידנית'}
                  </p>
                  {selectedContacts.slice(0, 5).map((c, i) => (
                    <div key={i} style={{ fontSize: '0.82rem', color: '#3B82F6', marginTop: '2px' }}>
                      • {c.name || c.email} {c.name ? `(${c.email})` : ''}
                    </div>
                  ))}
                  {selectedContacts.length > 5 && (
                    <div style={{ fontSize: '0.8rem', color: '#93C5FD', marginTop: '4px' }}>
                      + עוד {selectedContacts.length - 5} נמענים...
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Warning */}
            <p style={{ margin: '0 0 20px', fontSize: '0.85rem', color: '#6B7280', textAlign: 'center' }}>
              ⚠️ לאחר השליחה לא ניתן לבטל. בדוק שהנושא והתוכן נכונים לפני שמאשר.
            </p>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setShowSendConfirm(false)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  border: '1.5px solid #E5E7EB', background: '#fff',
                  fontSize: '0.95rem', fontWeight: 600, color: '#6B7280',
                  cursor: 'pointer',
                }}
              >
                ביטול
              </button>
              <button
                onClick={executeSend}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px',
                  border: 'none', background: '#16A34A',
                  fontSize: '0.95rem', fontWeight: 700, color: '#fff',
                  cursor: 'pointer',
                }}
              >
                ✅ כן, שלח עכשיו
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
