import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useUser } from '@clerk/clerk-react';
import {
  Sparkles, Zap, Users, FolderOpen, History, Lightbulb, BookOpen, Tag, Leaf,
  GraduationCap, Mail, RefreshCw, ChevronLeft, ChevronDown, ArrowRight, Check,
  X, Plus, Search, Image as ImageIcon, MousePointerClick, Package, Eye, Send,
  FlaskConical, CircleCheck, Coffee, MessageCircle, ShoppingCart, Pencil,
  Save, Trash2, Copy, ExternalLink, Upload, Download, UserPlus, Info,
  TriangleAlert, PauseCircle, CalendarDays, FileText,
} from 'lucide-react';
import { useApp } from '../lib/context';
import { callCampaignFunction } from '../lib/brevo';
import { ProgressBar, useAnimatedProgress } from '../components/shared/ProgressBar';
// Email HTML is built server-side (edge function) with banner images
import { supabase } from '../lib/supabase';
import './marketing.css';

// Progress fill for long-running jobs: Minuto olive, the page's only accent.
const BRAND = '#3D4A2E';

const TABS = [
  { id: 'compose',     label: 'קמפיין אוטומטי', icon: Sparkles },
  { id: 'automations', label: 'אוטומציות',      icon: Zap },
  { id: 'contacts',    label: 'אנשי קשר',       icon: Users },
  { id: 'groups',      label: 'קבוצות',         icon: FolderOpen },
  { id: 'history',     label: 'היסטוריה',       icon: History },
];

const THEME_LABELS = {
  tips:      'טיפים',
  story:     'סיפור',
  promo:     'מבצע',
  seasonal:  'עונתי',
  education: 'חינוך',
};

const THEME_ICONS = {
  tips:      Lightbulb,
  story:     BookOpen,
  promo:     Tag,
  seasonal:  Leaf,
  education: GraduationCap,
};

// localStorage key used to remember the campaign the user is currently editing
// so a page refresh drops them back into the editor with the same draft loaded.
const ACTIVE_DRAFT_KEY = 'coffeeflow:marketing:activeDraftId';
// Debounce window (ms) between edits and autosave.
const AUTOSAVE_DEBOUNCE_MS = 1500;

function AutosaveStatus({ saving, dirty, lastSavedAt, onSaveNow, hasDraftId }) {
  if (!hasDraftId) return null;
  let label, tone;
  if (saving) {
    label = 'שומר…';
    tone = 'warn';
  } else if (dirty) {
    label = 'שינויים לא שמורים';
    tone = 'warn';
  } else if (lastSavedAt) {
    label = 'נשמר אוטומטית';
    tone = 'ok';
  } else {
    label = 'שמירה אוטומטית פעילה';
    tone = '';
  }
  return (
    <div className="flex items-center gap-1">
      <span className="mkt-status" aria-live="polite">
        <i className={`dot ${tone ? `dot-${tone}` : ''}`} aria-hidden="true" />
        {label}
      </span>
      {dirty && !saving && (
        <button
          onClick={onSaveNow}
          className="btn-ghost mkt-btn-sm"
          title="שמירה עכשיו, בלי להמתין"
        >
          שמירה עכשיו
        </button>
      )}
    </div>
  );
}

export default function Marketing() {
  const { data, user, showToast, marketingContactsDb, campaignsDb, contactGroupsDb, contactGroupMembersDb } = useApp();
  const [activeTab, setActiveTab] = useState(() => {
    // Honor a ?tab= deep-link (e.g. the home "Needs You" panel links straight
    // to History so you land on the drafts, not the empty compose form).
    const t = new URLSearchParams(window.location.search).get('tab');
    return TABS.some(tab => tab.id === t) ? t : 'compose';
  });
  const [duplicateData, setDuplicateData] = useState(null);
  const [editData, setEditData] = useState(null);

  const handleDuplicate = (campaign) => {
    setDuplicateData(campaign);
    setActiveTab('compose');
  };

  const handleEdit = (campaign) => {
    setEditData(campaign);
    setActiveTab('compose');
  };

  // On phones the tab bar scrolls sideways; keep the active tab visible
  // (a ?tab=history deep link would otherwise land on an off-screen tab).
  const tabsRef = useRef(null);
  useEffect(() => {
    const el = tabsRef.current?.querySelector('[aria-pressed="true"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  return (
    <div className="mkt fade-up">
      <header className="page-header">
        <div>
          <h1>מחולל מיילים</h1>
          <p className="page-sub">קמפיינים, אוטומציות ורשימת הנמענים של מינוטו</p>
        </div>
      </header>

      <nav className="mkt-tabs" aria-label="אזורי מחולל המיילים" ref={tabsRef}>
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="mkt-tab"
              aria-pressed={activeTab === tab.id}
            >
              <Icon size={16} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === 'compose'     && <AutoComposeTab data={data} user={user} showToast={showToast} duplicateData={duplicateData} clearDuplicate={() => setDuplicateData(null)} editData={editData} clearEdit={() => setEditData(null)} campaignsDb={campaignsDb} />}
      {activeTab === 'automations' && <AutomationsTab data={data} user={user} showToast={showToast} />}
      {activeTab === 'contacts'    && <ContactsTab data={data} user={user} showToast={showToast} marketingContactsDb={marketingContactsDb} />}
      {activeTab === 'groups'      && <GroupsTab data={data} showToast={showToast} contactGroupsDb={contactGroupsDb} contactGroupMembersDb={contactGroupMembersDb} />}
      {activeTab === 'history'     && <HistoryTab data={data} user={user} showToast={showToast} onDuplicate={handleDuplicate} onEdit={handleEdit} />}
    </div>
  );
}

// ── Auto Compose Tab (AI-powered one-click) ─────────────────────────────────

function AutoComposeTab({ data, user, showToast, duplicateData, clearDuplicate, editData, clearEdit, campaignsDb }) {
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
  // Group membership is not consent: a group send only reaches opted-in
  // contacts (generate-campaign enforces the same server-side).
  const optedInEmails = useMemo(() => new Set(
    (data.marketingContacts || [])
      .filter(c => c.opted_in && c.email)
      .map(c => c.email.toLowerCase().trim())
  ), [data.marketingContacts]);

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
        showToast('שוכפל בלי יצירה מחדש. אפשר לערוך ולשמור', 'warning');
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
      showToast(`שגיאה בקבלת רעיונות: ${err.message}`, 'error');
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
      showToast(`שגיאה ביצירת קמפיין: ${err.message}`, 'error');
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
      showToast(`שגיאה ביצירת קמפיין: ${err.message}`, 'error');
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
        showToast(`שגיאה בטעינת הקמפיין: ${err.message}`, 'error');
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
      if (!isAuto) showToast('שמירה אחרת עדיין רצה. כדאי לנסות שוב בעוד רגע', 'warning');
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
        if (!isAuto) showToast('השינויים נשמרו');
      } else if (result?.error) {
        throw new Error(result.error);
      }
    } catch (err) {
      console.error('saveEdits failed:', err);
      const msg = err?.message || 'שגיאה לא ידועה';
      showToast(`שגיאה בשמירה: ${msg}`, 'error');
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
      showToast('נא להזין כתובת מייל לטסט', 'warning');
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
        showToast(`טסט נשלח ל-${testEmail}!`);
      } else {
        const firstErr = Array.isArray(result?.errors) && result.errors.length > 0
          ? result.errors[0]
          : 'Resend rejected the send (no details)';
        console.error('send-test failed:', result);
        showToast(`הטסט לא נשלח: ${firstErr}`, 'error');
      }
      setStep('draft');
    } catch (err) {
      console.error('send-test threw:', err);
      showToast(`שגיאה בשליחת טסט: ${err?.message || 'unknown'}`, 'error');
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
        ? 'לא נבחרה קבוצה או שהקבוצה ריקה'
        : sendMode === 'selected'
          ? 'לא נבחרו נמענים'
          : 'אין אנשי קשר שאישרו קבלת מיילים';
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
      const skipped = result?.consentSkipped
        ? ` (${result.consentSkipped} דולגו: לא אישרו קבלת דיוור)`
        : '';
      showToast(`הקמפיין נשלח ל-${result.sent} נמענים!${skipped}`);
      setStep('sent');
    } catch (err) {
      showToast(`שגיאה בשליחה: ${err.message}`, 'error');
      setStep('draft');
    }
  };

  // One-click send to every member of every test-flagged group.
  // Uses the same selectedRecipients backend path as manual/group sends.
  const sendToTestGroups = async () => {
    if (!draft?.id) return;
    if (testGroupMembers.length === 0) {
      showToast('אין חברים בקבוצות הבדיקה', 'warning');
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
        showToast(`נשלח ל-${result.sent} חברי קבוצת בדיקה!`);
      } else {
        const firstErr = Array.isArray(result?.errors) && result.errors.length > 0
          ? result.errors[0]
          : 'Resend rejected the send (no details)';
        showToast(`שליחה לקבוצת בדיקה נכשלה: ${firstErr}`, 'error');
      }
      setStep('draft');
    } catch (err) {
      showToast(`שגיאה: ${err?.message || 'unknown'}`, 'error');
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
      showToast(`סונכרנו ${result.synced} מוצרים מ-WooCommerce`);
    } catch (err) {
      showToast(`שגיאה בסנכרון: ${err.message}`, 'error');
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
      <section className="card p-0 max-w-[720px]">
        <div className="px-5 pt-6 pb-5 sm:px-7 sm:pt-7">
          <span className="mkt-ico brand w-10 h-10 mb-4" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <h2 className="text-[17px] font-semibold text-surface-900">
            יצירת קמפיין אוטומטי
          </h2>
          <p className="text-sm text-surface-700 mt-1 max-w-[460px] text-pretty">
            ה-AI כותב מייל בעברית עם מוצרים מהחנות. נשאר רק לבדוק, לאשר ולשלוח.
          </p>

          {/* Context / prompt area */}
          <div className="mt-5">
            <button
              onClick={() => setShowContext(prev => !prev)}
              className="btn-ghost mkt-btn-sm"
              aria-expanded={showContext}
            >
              <ChevronDown
                size={16}
                aria-hidden="true"
                className="mkt-chev side text-surface-500"
              />
              כיוון ל-AI (לא חובה)
            </button>

            {showContext && (
              <div className="mt-2 flex flex-col gap-3">
                <textarea className="field"
                  placeholder="על מה הקמפיין? למשל: הגיע קפה חדש, יש מבצע, תקופת חגים"
                  value={hint}
                  onChange={e => setHint(e.target.value)}
                  rows={3}
                  aria-label="כיוון ל-AI"
                />
                <div className="mkt-chips">
                  {[
                    { label: 'קיץ', text: 'תקופת קיץ, קפה קר ומרענן' },
                    { label: 'חגים', text: 'תקופת חגים, מתנות ומבצעים' },
                    { label: 'מבצע', text: 'מבצע מיוחד באתר, הנחות' },
                    { label: 'מוצר חדש', text: 'מוצר חדש שהגיע לחנות' },
                    { label: 'קלייה חדשה', text: 'קלייה חדשה שהגיעה, מקור יחיד' },
                    { label: 'כוסות ואביזרים', text: 'קידום כוסות ואביזרי קפה' },
                  ].map(chip => (
                    <button
                      key={chip.label}
                      onClick={() => setHint(prev => prev ? `${prev}, ${chip.text}` : chip.text)}
                      className="mkt-chip"
                      aria-pressed={hint.includes(chip.text)}
                    >
                      {hint.includes(chip.text) && <Check size={14} aria-hidden="true" />}
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mt-6">
            <button
              onClick={getIdeas}
              disabled={ideasLoading}
              className="btn-primary"
            >
              <Lightbulb size={16} aria-hidden="true" />
              {ideasLoading ? 'מחפש רעיונות…' : 'רעיונות לקמפיין'}
            </button>
            <button
              onClick={generateCampaign}
              className="btn-secondary"
            >
              יצירה ישירה
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 sm:px-7 border-t border-surface-200 bg-surface-50 rounded-b-[10px]">
          <span className="text-[13px] text-surface-500">
            <span className="num font-medium text-surface-900">{optedInCount}</span> נמענים מאושרים
          </span>
          <button onClick={syncProducts} disabled={syncing} className="btn-ghost mkt-btn-sm">
            <RefreshCw size={16} aria-hidden="true" />
            {syncing ? 'מסנכרן…' : 'סנכרון מוצרים מ-WooCommerce'}
          </button>
        </div>
      </section>
    );
  }

  // ── IDEAS: Pick a concept ──────────────────────────────────────────────

  if (step === 'ideas') {
    return (
      <section>
        <div className="mkt-sec-head">
          <div>
            <h2>בחירת רעיון לקמפיין</h2>
            <p className="mkt-sec-sub">בחירה ברעיון יוצרת טיוטה מלאה לעריכה.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setIdeas([]); setStep('idle'); }} className="btn-secondary mkt-btn-sm">
              <ArrowRight size={16} aria-hidden="true" />
              חזרה
            </button>
            <button onClick={getIdeas} disabled={ideasLoading} className="btn-secondary mkt-btn-sm">
              <RefreshCw size={16} aria-hidden="true" />
              רעיונות חדשים
            </button>
          </div>
        </div>
        {ideasLoading && (
          <div className="mb-4">
            <ProgressBar progress={ideasProgress.progress} label="מחפש רעיונות…" color={BRAND} height={6} />
          </div>
        )}

        {hint.trim() && (
          <div className="notice text-[13px] mb-4">
            <Info size={16} aria-hidden="true" />
            <span><strong>כיוון ל-AI:</strong> {hint}</span>
          </div>
        )}

        <div className="mkt-stack-sm">
          {ideas.map((idea, i) => {
            const ThemeIcon = THEME_ICONS[idea.theme] || Mail;
            return (
              <button
                key={i}
                type="button"
                onClick={() => generateFromIdea(idea)}
                className="mkt-idea"
              >
                <span className="mkt-ico" aria-hidden="true">
                  <ThemeIcon size={18} />
                </span>
                <span className="flex-1 min-w-0 block">
                  <span className="t">{idea.title}</span>
                  <span className="d">{idea.description}</span>
                  {idea.suggestedProducts && idea.suggestedProducts.length > 0 && (
                    <span className="flex flex-wrap gap-1.5 mt-2.5">
                      {idea.suggestedProducts.map((prod, j) => (
                        <span key={j} className="tag font-medium">
                          {prod}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="go">
                  בחירה
                  <ChevronLeft size={16} aria-hidden="true" />
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5">
          <button onClick={generateCampaign} className="btn-ghost mkt-btn-sm">
            יצירת קמפיין בלי רעיון מוכן
          </button>
        </div>
      </section>
    );
  }

  // ── GENERATING: Loading ────────────────────────────────────────────────

  if (step === 'generating') {
    return (
      <section className="card max-w-[720px] px-5 py-8 sm:px-7">
        <span className="mkt-ico brand w-10 h-10 mb-4" aria-hidden="true">
          <Sparkles size={18} />
        </span>
        <h2 className="text-[17px] font-semibold text-surface-900">יוצרים את הקמפיין…</h2>
        <p className="text-sm text-surface-500 mt-1 mb-6">סנכרון מוצרים, כתיבת התוכן בעברית ובניית העיצוב</p>
        <div className="max-w-[420px]" role="status">
          <ProgressBar progress={genProgress.progress} label="יצירת קמפיין" color={BRAND} height={6} />
        </div>
      </section>
    );
  }

  // ── SENT: Success ─────────────────────────────────────────────────────

  if (step === 'sent') {
    return (
      <section className="card max-w-[720px] px-5 py-8 sm:px-7">
        <span className="mkt-ico ok w-10 h-10 mb-4" aria-hidden="true">
          <CircleCheck size={18} />
        </span>
        <h2 className="text-[17px] font-semibold text-surface-900">הקמפיין נשלח</h2>
        <p className="text-sm text-surface-500 mt-1 mb-6">
          המייל נשלח ל-<span className="num">{optedInCount}</span> נמענים
        </p>
        <button onClick={() => {
          setDraft(null); setStep('idle'); setHint('');
          try { localStorage.removeItem(ACTIVE_DRAFT_KEY); } catch {}
        }} className="btn-primary">
          <Plus size={16} aria-hidden="true" />
          קמפיין חדש
        </button>
      </section>
    );
  }

  // ── DRAFT / SENDING: Review & Approve ─────────────────────────────────

  return (
    <section>
      <div className="mkt-sec-head items-center">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2>עריכת הקמפיין</h2>
          {draft?.theme && (
            <span className="tag">
              {THEME_LABELS[draft.theme] || draft.theme}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <AutosaveStatus saving={saving} dirty={dirty} lastSavedAt={lastSavedAt} onSaveNow={() => saveEdits(false)} hasDraftId={!!draft?.id} />
          <button onClick={regenerate} className="btn-secondary mkt-btn-sm">
            <RefreshCw size={16} aria-hidden="true" />
            יצירה מחדש
          </button>
        </div>
      </div>

      <div className="mkt-stack">
      {/* Banner text — subject + preheader overlay */}
      <div className="card">
        <h3 className="mkt-card-title"><ImageIcon size={16} aria-hidden="true" />טקסט על הבאנר</h3>
        <div className="mkt-stack-sm">
          <label className="mkt-field">
            <span className="field-label">כותרת (מופיעה על התמונה)</span>
            <input
              type="text"
              value={editSubject}
              onChange={onFieldChange(setEditSubject)}
              className="field font-medium"
            />
          </label>
          <label className="mkt-field">
            <span className="field-label">תת-כותרת (מופיעה מתחת לכותרת)</span>
            <input className="field"
              type="text"
              value={editPreheader}
              onChange={onFieldChange(setEditPreheader)}
              placeholder="משפט קצר שמופיע מתחת לכותרת על הבאנר"
            />
          </label>
        </div>
      </div>

      {/* Greeting + Body */}
      <div className="card">
        <h3 className="mkt-card-title"><FileText size={16} aria-hidden="true" />תוכן המייל</h3>
        <div className="mkt-stack-sm">
          <label className="mkt-field">
            <span className="field-label">פתיחה</span>
            <input className="field"
              type="text"
              value={editGreeting}
              onChange={onFieldChange(setEditGreeting)}
              placeholder="היי / שלום / מה קורה"
            />
          </label>
          <label className="mkt-field">
            <span className="field-label">תוכן ההודעה</span>
            <textarea className="field"
              value={editBody}
              onChange={onFieldChange(setEditBody)}
              rows={6}
            />
          </label>
          <div className="mkt-field">
            <label className="field-label" htmlFor="mkt-promo-deadline">
              תאריך סיום מבצע <span className="font-normal text-surface-500">(לא חובה, מופיע בתחתית המייל)</span>
            </label>
            <input
              id="mkt-promo-deadline"
              type="date"
              value={promoDeadline}
              onChange={onFieldChange(setPromoDeadline)}
              dir="ltr"
              className="field max-w-[200px]"
            />
            {promoDeadline && (
              <p className="mkt-help flex items-start gap-1.5">
                <CalendarDays size={14} aria-hidden="true" className="shrink-0 mt-0.5" />
                <span>יוצג: המבצע עד ה־{new Date(promoDeadline).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })} או עד גמר המלאי, הראשון מבינהם | ט.ל.ח</span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* CTA button — text + link */}
      <div className="card">
        <h3 className="mkt-card-title"><MousePointerClick size={16} aria-hidden="true" />כפתור פעולה (CTA)</h3>
        <div className="mkt-row-fields">
          <label className="mkt-field flex-[1_1_180px]">
            <span className="field-label">טקסט הכפתור</span>
            <input className="field"
              type="text"
              value={editCtaText}
              onChange={onFieldChange(setEditCtaText)}
              placeholder="לחנות"
            />
          </label>
          <label className="mkt-field flex-[2_1_280px]">
            <span className="field-label">קישור</span>
            <input
              type="url"
              value={editCtaUrl}
              onChange={onFieldChange(setEditCtaUrl)}
              placeholder="https://minuto.co.il/shop"
              dir="ltr"
              className="field mkt-mono"
            />
          </label>
        </div>
        <p className="mkt-help mt-2">
          שדה ריק מסתיר את הכפתור. התצוגה המקדימה מתעדכנת אחרי השמירה.
        </p>
      </div>

      {/* Products — with add/remove */}
      <div className="card">
        <h3 className="mkt-card-title">
          <Package size={16} aria-hidden="true" />
          מוצרים במייל
          <span className="meta num">{(draft?.products || []).length}</span>
        </h3>

        {/* Always-visible product search with autocomplete dropdown */}
        <div className="mkt-search mb-3">
          <Search size={16} aria-hidden="true" />
          <input className="field"
            type="text"
            value={productSearch}
            onChange={e => { setProductSearch(e.target.value); if (!allProducts.length) loadAllProducts(); }}
            onFocus={() => { if (!allProducts.length) loadAllProducts(); }}
            placeholder="חיפוש מוצר להוספה"
            aria-label="חיפוש מוצר להוספה"
          />
          {/* Dropdown — show when search has text OR products loaded and field focused */}
          {productSearch.trim() && (
            <div className="mkt-pop mkt-rows">
              {allProducts
                .filter(p => (p.name || '').toLowerCase().includes(productSearch.toLowerCase()))
                .slice(0, 15)
                .map(p => {
                  const alreadyAdded = (draft?.products || []).some(dp => dp.woo_id === p.woo_id);
                  return (
                    <button
                      key={p.woo_id}
                      type="button"
                      onClick={() => { if (!alreadyAdded) { addProduct(p); setProductSearch(''); } }}
                      disabled={alreadyAdded}
                      className="mkt-opt"
                    >
                      {p.image_url && (
                        <img src={p.image_url} alt="" className="mkt-thumb" />
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-medium text-surface-900 truncate">{p.name}</span>
                        {p.price && <span className="block text-xs text-surface-500 num">₪{parseFloat(p.price).toLocaleString()}</span>}
                      </span>
                      {alreadyAdded
                        ? <span className="inline-flex items-center gap-1 text-xs text-surface-500 shrink-0"><Check size={14} aria-hidden="true" />נוסף</span>
                        : <Plus size={16} aria-hidden="true" className="text-surface-500 shrink-0" />
                      }
                    </button>
                  );
                })}
              {allProducts.filter(p => (p.name || '').toLowerCase().includes(productSearch.toLowerCase())).length === 0 && (
                <div className="px-3 py-4 text-[13px] text-surface-500 text-center">לא נמצאו מוצרים</div>
              )}
            </div>
          )}
        </div>

        {/* Current products */}
        <div className="flex flex-wrap gap-2">
          {(draft?.products || []).map(p => (
            <div key={p.woo_id} className="mkt-prod">
              {p.image_url && (
                <img src={p.image_url} alt="" className="mkt-thumb" />
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-surface-900 truncate max-w-[220px]">{p.name}</div>
                {p.price && <div className="text-xs text-surface-500 num">₪{p.price}</div>}
              </div>
              <button
                onClick={() => removeProduct(p.woo_id)}
                className="mkt-icon-btn"
                aria-label={`הסרת ${p.name} מהמייל`}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
          {(draft?.products || []).length === 0 && (
            <p className="text-[13px] text-surface-500">אין מוצרים במייל. אפשר להוסיף מהחיפוש למעלה.</p>
          )}
        </div>
      </div>

      {/* Preview updates automatically after autosave. No banner needed. */}

      <div className="card">
        <h3 className="mkt-card-title"><Eye size={16} aria-hidden="true" />תצוגה מקדימה</h3>
        <iframe
          src={previewBlobUrl || 'about:blank'}
          className="mkt-preview h-[600px]"
          title="Email Preview"
        />
      </div>

      {/* Actions */}
      <div className="card">
        <h3 className="mkt-card-title"><Send size={16} aria-hidden="true" />שליחה</h3>

        {/* Test send */}
        <div className="mkt-field mb-5">
          <span className="field-label" id="mkt-test-label">שליחת טסט</span>
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              placeholder="כתובת לשליחת טסט"
              value={testEmail}
              onChange={e => setTestEmail(e.target.value)}
              dir="auto"
              aria-labelledby="mkt-test-label"
              className="field mkt-mono w-auto flex-[1_1_200px]"
            />
            <button
              onClick={sendTest}
              disabled={step === 'sending'}
              className="btn-secondary"
            >
              <Mail size={16} aria-hidden="true" />
              שליחת טסט
            </button>
            {/* One-click: send draft to every member of every test-flagged group */}
            {testGroupMembers.length > 0 && (
              <button
                onClick={sendToTestGroups}
                disabled={step === 'sending'}
                className="btn-secondary"
                title={`שליחה לקבוצות הבדיקה (${testGroupMembers.length} נמענים)`}
              >
                <FlaskConical size={16} aria-hidden="true" />
                לקבוצת הבדיקה <span className="num text-surface-500">({testGroupMembers.length})</span>
              </button>
            )}
          </div>
        </div>

        {/* Send mode toggle */}
        <div className="mkt-field mb-3">
          <span className="field-label" id="mkt-send-mode">נמענים</span>
          <div className="mkt-seg full" role="group" aria-labelledby="mkt-send-mode">
            <button
              onClick={() => { setSendMode('all'); setShowContactPicker(false); setSelectedGroupId(null); }}
              aria-pressed={sendMode === 'all'}
            >
              כל הנמענים <span className="num">({optedInCount})</span>
            </button>
            <button
              onClick={() => { setSendMode('group'); setShowContactPicker(false); }}
              aria-pressed={sendMode === 'group'}
            >
              קבוצה {selectedGroupId ? <span className="num">({selectedContacts.length})</span> : ''}
            </button>
            <button
              onClick={() => { setSendMode('selected'); setShowContactPicker(true); setSelectedGroupId(null); }}
              aria-pressed={sendMode === 'selected'}
            >
              בחירה ידנית {sendMode === 'selected' && selectedContacts.length > 0 ? <span className="num">({selectedContacts.length})</span> : ''}
            </button>
          </div>
        </div>

        {/* Group picker */}
        {sendMode === 'group' && (
          <div className="mkt-pick mb-4">
            {(data.contactGroups || []).length === 0 ? (
              <div className="px-3 py-4 text-[13px] text-surface-500 text-center">
                אין קבוצות עדיין. אפשר ליצור קבוצה בלשונית "קבוצות".
              </div>
            ) : (
              <div className="mkt-rows" role="radiogroup" aria-label="בחירת קבוצה">
                {(data.contactGroups || []).map(g => {
                  const groupMembers = (data.contactGroupMembers || []).filter(m => m.group_id === g.id);
                  const count = groupMembers.length;
                  const sendable = groupMembers.filter(m => optedInEmails.has((m.email || '').toLowerCase().trim())).length;
                  const isSelected = selectedGroupId === g.id;
                  return (
                    <label
                      key={g.id}
                      className="mkt-pick-row"
                      data-selected={isSelected}
                    >
                      <input
                        type="radio"
                        name="group-pick"
                        checked={isSelected}
                        onChange={() => {
                          setSelectedGroupId(g.id);
                          // Group membership is not consent: only opted-in
                          // contacts are sendable (the backend enforces the same).
                          const members = groupMembers
                            .filter(m => optedInEmails.has((m.email || '').toLowerCase().trim()))
                            .map(m => ({ email: m.email, name: m.name || undefined }));
                          setSelectedContacts(members);
                        }}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-surface-900">{g.name}</span>
                          {g.is_test_group && (
                            <span className="tag tag-warn">בדיקה</span>
                          )}
                        </span>
                        <span className="block text-xs text-surface-500 mt-0.5">
                          <span className="num">{count}</span> חברים{sendable < count ? ` · ${sendable} אישרו דיוור` : ''}{g.description ? ` · ${g.description}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Contact picker */}
        {showContactPicker && (
          <div className="mkt-pick mb-4 p-3 flex flex-col gap-2.5 max-h-[340px]">
            <div className="mkt-search">
              <Search size={16} aria-hidden="true" />
              <input className="field"
                type="text"
                placeholder="חיפוש לפי שם או מייל"
                aria-label="חיפוש נמענים לפי שם או מייל"
                value={contactSearch}
                onChange={e => setContactSearch(e.target.value)}
              />
            </div>
            {selectedContacts.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {selectedContacts.map(c => (
                  <span key={c.email} className="mkt-token">
                    <span>{c.name || c.email}</span>
                    <button
                      onClick={() => setSelectedContacts(prev => prev.filter(s => s.email !== c.email))}
                      aria-label={`הסרת ${c.name || c.email}`}
                    ><X size={12} aria-hidden="true" /></button>
                  </span>
                ))}
                <button
                  onClick={() => setSelectedContacts([])}
                  className="btn-ghost mkt-btn-sm h-7"
                >ניקוי הבחירה</button>
              </div>
            )}
            <div className="overflow-y-auto max-h-[200px] rounded-lg border border-surface-200 mkt-rows">
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
                    <label key={c.id} className="mkt-pick-row" data-selected={isSelected}>
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
                      />
                      <span className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[13px] font-medium text-surface-900">{c.name || '—'}</span>
                        <span className="text-xs text-surface-500 truncate" dir="ltr">{c.email}</span>
                      </span>
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
          className="btn-primary mkt-btn-lg mt-2"
        >
          <Send size={16} aria-hidden="true" />
          {step === 'sending'
            ? 'שולח…'
            : sendMode === 'group'
              ? `שליחה לקבוצה (${selectedContacts.length} חברים)`
              : sendMode === 'selected'
                ? `שליחה ל-${selectedContacts.length} נמענים שנבחרו`
                : `אישור ושליחה ל-${optedInCount} נמענים`
          }
        </button>
      </div>
      </div>

      {/* ── Send Confirmation Modal ─────────────────────────────────────────── */}
      {showSendConfirm && (
        <div
          className="mkt-scrim"
          onKeyDown={e => { if (e.key === 'Escape') setShowSendConfirm(false); }}
        >
          <div
            className="mkt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mkt-send-confirm-title"
          >
            {/* Header */}
            <div className="flex items-center gap-3 mb-5">
              <span className="mkt-ico brand" aria-hidden="true"><Send size={18} /></span>
              <h3 id="mkt-send-confirm-title">אישור שליחת קמפיין</h3>
            </div>

            {/* What */}
            <div className="mkt-modal-block mb-3">
              <p className="b-label">נושא המייל</p>
              <p className="text-[15px] font-semibold text-surface-900">
                {editSubject || draft?.subject || '—'}
              </p>
            </div>

            {/* To whom */}
            <div className="mkt-modal-block mb-4">
              <p className="b-label">נמענים</p>
              {sendMode === 'all' ? (
                <p className="text-sm text-surface-900">
                  <strong className="num font-semibold">{optedInCount}</strong> אנשי קשר שאישרו קבלת מיילים
                </p>
              ) : (
                <>
                  <p className="text-sm text-surface-900 mb-1.5">
                    <strong className="num font-semibold">{selectedContacts.length}</strong>
                    {sendMode === 'group'
                      ? ` חברים בקבוצה "${(data.contactGroups || []).find(g => g.id === selectedGroupId)?.name || ''}"`
                      : ' נמענים שנבחרו ידנית'}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {selectedContacts.slice(0, 5).map((c, i) => (
                      <li key={i} className="text-[13px] text-surface-700 truncate">
                        {c.name || c.email} {c.name ? <span className="text-surface-500" dir="ltr">({c.email})</span> : ''}
                      </li>
                    ))}
                  </ul>
                  {selectedContacts.length > 5 && (
                    <div className="text-xs text-surface-500 mt-1">
                      ועוד <span className="num">{selectedContacts.length - 5}</span> נמענים
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Warning */}
            <div className="notice notice-warn mb-5">
              <TriangleAlert size={16} aria-hidden="true" />
              <span>אחרי השליחה אי אפשר לבטל. כדאי לוודא שהנושא והתוכן נכונים.</span>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowSendConfirm(false)}
                className="btn-secondary flex-1"
                autoFocus
              >
                ביטול
              </button>
              <button
                onClick={executeSend}
                className="btn-primary flex-[2]"
              >
                <Send size={16} aria-hidden="true" />
                שליחה עכשיו
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Automations Tab ─────────────────────────────────────────────────────────

function AutomationsTab({ data, user, showToast }) {
  // The "coming soon" placeholders — kept around so the UI shows the
  // roadmap. Real automations live in email_automation_templates and are
  // pulled from the DB by the EmailAutomationCard cards below.
  const PLACEHOLDER_AUTOMATIONS = [
    {
      type: 'welcome_signup',
      icon: UserPlus,
      title: 'מייל ברוכים הבאים (הרשמה לרשימה)',
      description: 'נשלח אוטומטית לאלו שנרשמו לרשימת התפוצה (בלי הזמנה)',
      trigger: 'הרשמה לרשימה',
      delay: 'מיידי',
    },
  ];

  // Live triggers backed by email_automation_templates rows. Each renders
  // its own self-contained EmailAutomationCard (toggle / test-send / dry-run
  // / history / editor), keyed by trigger_type.
  const LIVE_TRIGGERS = ['first_purchase', 'coffee_checkin', 'refill_reminder', 'abandoned_cart_1', 'abandoned_cart_2'];

  return (
    <section>
      <div className="mkt-sec-head">
        <div>
          <h2>אוטומציות מייל</h2>
          <p className="mkt-sec-sub max-w-[640px]">
            מיילים שנכתבים פעם אחת ורצים לבד. אירועים ב-WooCommerce מפעילים אותם, והשליחה רצה דרך CoffeeFlow (לא Flashy).
          </p>
        </div>
      </div>

      {/* The active automations — each wired to email-automation-scheduler.
          Reads the logged-in user's email from Clerk directly inside the
          component (not from useApp().user, which is a hardcoded stub
          pinned to the legacy marketing_contacts user_id). */}
      <div className="mkt-stack-sm">
        {LIVE_TRIGGERS.map(tt => (
          <EmailAutomationCard key={tt} trigger={tt} showToast={showToast} />
        ))}
      </div>

      <ReminderStopPanel showToast={showToast} />

      <h3 className="text-[15px] font-semibold text-surface-900 mt-8 mb-3">בקרוב</h3>
      <div className="mkt-stack-sm">
        {PLACEHOLDER_AUTOMATIONS.map(auto => {
          const AutoIcon = auto.icon;
          return (
            <div key={auto.type} className="card flex gap-3 items-start">
              <span className="mkt-ico" aria-hidden="true"><AutoIcon size={18} /></span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-[15px] font-semibold text-surface-700">{auto.title}</h4>
                  <span className="tag">בקרוב</span>
                </div>
                <p className="text-[13px] text-surface-500 mt-1">{auto.description}</p>
                <div className="flex gap-1.5 flex-wrap mt-3">
                  <span className="tag font-medium">
                    טריגר: {auto.trigger}
                  </span>
                  <span className="tag font-medium">
                    עיכוב: {auto.delay}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="notice text-[13px] mt-6">
        <Info size={16} aria-hidden="true" />
        <div>
          <strong>איך זה עובד</strong>
          <ol className="list-decimal ps-4 mt-1.5 flex flex-col gap-1">
            <li>WooCommerce מסנכרן הזמנות ל-CoffeeFlow כל שעה.</li>
            <li>ה-scheduler מזהה לקוחות שעומדים בתנאי של האוטומציה (למשל קנייה ראשונה, 3 ימים אחרי ההזמנה).</li>
            <li>נוצר קופון ייחודי ללקוח ב-WooCommerce, והמייל נשלח דרך Resend.</li>
            <li>כל מייל נשמר ב-CoffeeFlow: אפשר לראות מה נשלח ולמי, בלי תלות ב-Flashy.</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

// ── Email Automation Card ──────────────────────────────────────────────────
//
// Reusable card for one email_automation_templates trigger. Reads/writes
// the template + its email_automations rows, calls the
// email-automation-scheduler edge function for test sends and dry runs.
//
// Controls (all keyed off the `trigger` prop):
//   - Enable toggle (flip 'enabled' in email_automation_templates)
//   - Test-send button (sends this trigger's email; real coupon if the
//     template has one)
//   - Dry-run (how many candidates this trigger would catch next run)
//   - View sent history (shows last 10 from email_automations)
//   - Inline subject/body editor with preview
//
// Stats (sent/failed counts) are pulled from email_automations on mount.

// Per-trigger presentation: icon + a human description built from the
// template's own delay/lookback fields, so copy stays in sync with config.
const AUTOMATION_META = {
  first_purchase: {
    icon: Coffee,
    blurb: (t) => `נשלח ${t.delay_days} ימים אחרי ההזמנה הראשונה, רק ללקוחות שהזמנתם הראשונה הייתה ב-${t.max_lookback_days} הימים האחרונים.`,
  },
  coffee_checkin: {
    icon: MessageCircle,
    blurb: (t) => `לקוחות שאישרו דיוור, עם הזמנה אחת בלבד שכללה פולי קפה: מייל "איך היה הקפה?" פעם אחת, ${t.delay_days} ימים אחרי שההזמנה הושלמה. ללא קופון. ${t.settings?.review_link_enabled ? 'כולל קישור לביקורת בגוגל.' : 'קישור הביקורת בגוגל כבוי (הביקורות בפרופיל מושהות).'}`,
  },
  refill_reminder: {
    icon: RefreshCw,
    blurb: (t) => `לקוחות עם ${t.settings?.min_orders ?? 3} הזמנות ומעלה, שאישרו דיוור: תזכורת לפי הקצב האישי (חציון הזמן בין הזמנות × ${t.settings?.cadence_factor ?? 0.85}). אחת לכל מחזור, עם קישור להפסקת תזכורות.`,
  },
  abandoned_cart_1: {
    icon: ShoppingCart,
    blurb: (t) => `תזכורת ראשונה: נשלח ${t.delay_days} יום אחרי שהתחילה הזמנה ולא הושלמה (חלון איסוף ${t.max_lookback_days} ימים).`,
  },
  abandoned_cart_2: {
    icon: ShoppingCart,
    blurb: (t) => `תזכורת שנייה: נשלח ${t.delay_days} ימים אחרי הזמנה שלא הושלמה, ורק אם מייל 1 כבר נשלח ללקוח.`,
  },
};

function EmailAutomationCard({ trigger, showToast }) {
  // Real Clerk user (not the useApp stub). primaryEmailAddress is the
  // canonical field; emailAddresses[0] is the fallback for users with
  // multiple emails where primary isn't set (rare, but worth handling).
  const { user: clerkUser } = useUser();
  const userEmail =
    clerkUser?.primaryEmailAddress?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    null;

  const [template, setTemplate] = useState(null);
  const [stats, setStats] = useState({ sent: 0, failed: 0, pending: 0 });
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [customTestEmail, setCustomTestEmail] = useState('');
  // Template editor state — populated when the user opens the editor;
  // only saved on click, so the user can cancel without affecting the
  // template that's actually used by the scheduler.
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: tmpl }, { data: rows }] = await Promise.all([
        supabase.from('email_automation_templates')
          .select('*').eq('trigger_type', trigger).maybeSingle(),
        supabase.from('email_automations')
          .select('id, customer_email, customer_name, coupon_code, status, sent_at, error_msg, created_at')
          .eq('trigger_type', trigger)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);
      setTemplate(tmpl);
      const all = rows ?? [];
      setStats({
        sent: all.filter(r => r.status === 'sent').length,
        failed: all.filter(r => r.status === 'failed').length,
        pending: all.filter(r => r.status === 'pending').length,
      });
      setRecent(all.slice(0, 10));
    } finally { setLoading(false); }
  }, [trigger]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggleEnabled = async () => {
    if (!template) return;
    setBusy(true);
    const { error } = await supabase
      .from('email_automation_templates')
      .update({ enabled: !template.enabled, updated_at: new Date().toISOString() })
      .eq('trigger_type', trigger);
    setBusy(false);
    if (error) {
      showToast(`שגיאה: ${error.message}`, 'error');
      return;
    }
    showToast(template.enabled ? 'האוטומציה הושבתה' : 'האוטומציה הופעלה');
    loadAll();
  };

  const testSend = async (emailOverride) => {
    // Prefer explicit override (custom input), then fall back to the
    // Clerk-logged-in user's email. The custom-input path exists because
    // testing the email content for non-employees often requires sending
    // to a personal address that isn't the dashboard login email.
    const targetEmail = (emailOverride ?? userEmail ?? '').trim();
    if (!targetEmail) {
      showToast('צריך להזין כתובת מייל לבדיקה', 'error');
      return;
    }
    if (!targetEmail.includes('@')) {
      showToast('כתובת מייל לא תקינה', 'error');
      return;
    }
    if (!confirm(`לשלוח מייל בדיקה ל-${targetEmail}? (יוצר קופון אמיתי ב-WooCommerce)`)) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('email-automation-scheduler', {
        body: { test_send: targetEmail, trigger_type: trigger },
      });
      if (error) throw error;
      if (data?.ok || data?.id) {
        showToast(`נשלח ל-${targetEmail}${data.coupon ? ` · קופון: ${data.coupon}` : ''}`);
      } else {
        showToast(`שליחה נכשלה: ${data?.error ?? 'unknown'}`, 'error');
      }
    } catch (e) {
      showToast(`שגיאה: ${e.message}`, 'error');
    } finally { setBusy(false); }
  };

  const dryRun = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('email-automation-scheduler', {
        body: { dry_run: true },
      });
      if (error) throw error;
      const run = (data?.runs ?? []).find(r => r.trigger === trigger);
      if (!run) {
        showToast('האוטומציה כבויה, אין מה לבדוק', 'warning');
      } else {
        showToast(`${run.candidates_count} לקוחות יקבלו מייל בריצה הבאה`);
        console.log('[automation dry run]', run);
      }
    } catch (e) {
      showToast(`שגיאה: ${e.message}`, 'error');
    } finally { setBusy(false); }
  };

  // Open the editor — copy current template values into local state so
  // the textarea is editable without mutating the loaded template until
  // the user clicks save.
  const openEditor = () => {
    if (!template) return;
    setEditSubject(template.subject_template ?? '');
    setEditBody(template.body_html_template ?? '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditSubject('');
    setEditBody('');
  };

  const saveEdit = async () => {
    if (!editSubject.trim() || !editBody.trim()) {
      showToast('נושא וגוף לא יכולים להיות ריקים', 'error');
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from('email_automation_templates')
      .update({
        subject_template: editSubject,
        body_html_template: editBody,
        updated_at: new Date().toISOString(),
      })
      .eq('trigger_type', trigger);
    setBusy(false);
    if (error) {
      showToast(`שגיאה בשמירה: ${error.message}`, 'error');
      return;
    }
    showToast('התבנית נשמרה');
    setEditing(false);
    loadAll();
  };

  // Render the body in a sandboxed new window so the user can see the
  // result with sample variables substituted before saving. Doesn't go
  // through Resend — purely a visual preview of the HTML.
  const openPreview = () => {
    const sampleVars = {
      first_name: 'ארז',
      coupon_code: 'MINUTO-PREVIEW',
      coupon_expiry_days: template?.coupon_expiry_days ?? 60,
      order_id: 80000,
      unsubscribe_url: '#preview',
      logo_url: 'https://www.minuto.co.il/content/uploads/2025/03/Frame-14.png',
    };
    const rendered = (editBody || template?.body_html_template || '')
      .replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, k) => String(sampleVars[k] ?? ''));
    const win = window.open('', '_blank', 'width=640,height=900');
    if (win) {
      win.document.write(rendered);
      win.document.close();
    } else {
      showToast('דפדפן חסם את חלון התצוגה המקדימה', 'error');
    }
  };

  if (loading) {
    return (
      <div className="card flex gap-3 items-start" role="status" aria-label="טוען נתוני אוטומציה">
        <span className="mkt-ico" aria-hidden="true" />
        <div className="flex-1 flex flex-col gap-2.5 pt-1.5">
          <div className="mkt-skel w-1/3" />
          <div className="mkt-skel w-3/4" />
          <div className="mkt-skel w-1/2" />
        </div>
      </div>
    );
  }
  if (!template) {
    return (
      <div className="notice notice-warn">
        <TriangleAlert size={16} aria-hidden="true" />
        <div>
          <strong>התבנית לא נמצאה</strong>
          <p className="mt-1">
            לא נמצאה תבנית עבור הטריגר <code dir="ltr">{trigger}</code>. צריך לוודא שה-migration המתאים רץ ב-Supabase (dev ואז prod).
          </p>
        </div>
      </div>
    );
  }

  const meta = AUTOMATION_META[trigger] ?? { icon: Mail, blurb: () => template.display_name };
  const MetaIcon = meta.icon;
  const hasCoupon = (template.coupon_percent ?? 0) > 0;
  const description = meta.blurb(template) +
    (hasCoupon ? ` כולל קופון ייחודי ${template.coupon_percent}% הנחה תקף ל-${template.coupon_expiry_days} ימים.` : '');
  const enabled = template.enabled;
  return (
    <div className="card">
      <div className="flex gap-3 items-start">
        <span className={`mkt-ico ${enabled ? 'brand' : ''}`} aria-hidden="true"><MetaIcon size={18} /></span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-surface-900">{template.display_name}</h3>
            {enabled
              ? <span className="tag tag-ok"><i className="dot" aria-hidden="true" />פעיל</span>
              : <span className="tag"><i className="dot" aria-hidden="true" />כבוי</span>}
          </div>
          <p className="text-[13px] text-surface-700 mt-1 leading-relaxed text-pretty">
            {description}
          </p>
          <div className="flex gap-1.5 flex-wrap mt-3">
            <span className="tag font-medium">
              נשלחו: <span className="num">{stats.sent}</span>
            </span>
            {stats.failed > 0 && (
              <span className="tag tag-danger">
                נכשלו: <span className="num">{stats.failed}</span>
              </span>
            )}
            {hasCoupon && (
              <span className="tag font-medium">
                קופון: <span className="num">{template.coupon_percent}%</span> · <span className="num">{template.coupon_expiry_days}</span> ימים
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-surface-200 flex flex-col gap-3">
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={toggleEnabled}
            disabled={busy}
            className={`${enabled ? 'btn-secondary' : 'btn-primary'} mkt-btn-sm`}
          >
            {enabled ? 'השבתה' : 'הפעלת האוטומציה'}
          </button>
          <button
            onClick={openEditor}
            disabled={busy || editing}
            className="btn-secondary mkt-btn-sm"
          >
            <Pencil size={16} aria-hidden="true" />
            עריכת המייל
          </button>
          <button
            onClick={dryRun}
            disabled={busy}
            className="btn-secondary mkt-btn-sm"
          >
            <Search size={16} aria-hidden="true" />
            כמה יקבלו בריצה הבאה
          </button>
          {recent.length > 0 && (
            <button
              onClick={() => setShowHistory(s => !s)}
              className="btn-ghost mkt-btn-sm"
              aria-expanded={showHistory}
            >
              <History size={16} aria-hidden="true" />
              {showHistory ? 'הסתרת ההיסטוריה' : <>היסטוריה <span className="num text-surface-500">({recent.length})</span></>}
            </button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-[13px] text-surface-500 me-1">מייל בדיקה</span>
          <button
            onClick={() => testSend()}
            disabled={busy || !userEmail}
            className="btn-secondary mkt-btn-sm"
            title={userEmail ? `שליחה אל ${userEmail}` : 'לא נמצאה כתובת, אפשר להזין כתובת בשדה'}
          >
            <Mail size={16} aria-hidden="true" />
            אליי {userEmail ? <span className="text-surface-500">({userEmail.split('@')[0]})</span> : ''}
          </button>
          <input
            type="email"
            placeholder="או כתובת מייל אחרת"
            aria-label="כתובת מייל אחרת לבדיקה"
            value={customTestEmail}
            onChange={e => setCustomTestEmail(e.target.value)}
            dir="auto"
            className="field min-h-8 h-8 py-1 w-auto flex-[1_1_200px] max-w-[280px] text-[13px]"
          />
          <button
            onClick={() => testSend(customTestEmail)}
            disabled={busy || !customTestEmail}
            className="btn-secondary mkt-btn-sm"
          >
            שליחה לכתובת הזו
          </button>
        </div>
      </div>

      {showHistory && (
        <div className="mt-4 card-flush overflow-hidden mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>תאריך</th>
                <th>לקוח</th>
                <th>קופון</th>
                <th>סטטוס</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(r => (
                <tr key={r.id}>
                  <td className="text-surface-500 whitespace-nowrap">
                    {(r.sent_at ?? r.created_at).slice(0, 10)}
                  </td>
                  <td><span dir="ltr" className="break-all">{r.customer_email}</span></td>
                  <td className="mkt-mono whitespace-nowrap">
                    {r.coupon_code ?? '—'}
                  </td>
                  <td>
                    <span
                      className={r.status === 'sent' ? 'tag tag-ok' : r.status === 'failed' ? 'tag tag-danger' : 'tag tag-warn'}
                      title={r.error_msg ?? ''}
                    >
                      {r.status === 'sent' ? 'נשלח' : r.status === 'failed' ? 'נכשל' : 'ממתין'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="mt-4 pt-4 border-t border-surface-200 flex flex-col gap-3">
          <h4 className="text-[15px] font-semibold text-surface-900">עריכת תבנית</h4>

          <label className="mkt-field">
            <span className="field-label">נושא המייל</span>
            <input className="field"
              type="text"
              value={editSubject}
              onChange={e => setEditSubject(e.target.value)}
              dir="rtl"
            />
          </label>

          <label className="mkt-field">
            <span className="field-label">גוף המייל (HTML)</span>
            <span className="mkt-help">
              משתנים זמינים: <span dir="ltr">{'{{ first_name }}'}, {'{{ coupon_code }}'}, {'{{ coupon_expiry_days }}'}, {'{{ logo_url }}'}, {'{{ unsubscribe_url }}'}</span>
            </span>
            <textarea
              value={editBody}
              onChange={e => setEditBody(e.target.value)}
              rows={20}
              dir="ltr"
              spellCheck={false}
              className="field mkt-mono text-[12.5px]"
            />
          </label>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={saveEdit}
              disabled={busy}
              className="btn-primary"
            >
              <Save size={16} aria-hidden="true" />
              שמירה
            </button>
            <button
              onClick={openPreview}
              disabled={busy}
              className="btn-secondary"
            >
              <Eye size={16} aria-hidden="true" />
              תצוגה מקדימה
            </button>
            <button
              onClick={cancelEdit}
              disabled={busy}
              className="btn-ghost"
            >
              ביטול
            </button>
          </div>

          <p className="mkt-help">
            השמירה מעדכנת את התבנית מיד. כדאי לשלוח מייל בדיקה אחרי השמירה ולוודא שהתוצאה נכונה.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Contacts Tab ────────────────────────────────────────────────────────────

function ContactsTab({ data, user, showToast, marketingContactsDb }) {
  const [contactFilter, setContactFilter] = useState('all');
  const [syncingResend, setSyncingResend] = useState(false);
  const [pushingResend, setPushingResend] = useState(false);
  const syncResendProgress = useAnimatedProgress(syncingResend, 20);
  const pushResendProgress = useAnimatedProgress(pushingResend, 30);
  const [importingFlashy, setImportingFlashy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newContactEmail, setNewContactEmail] = useState('');
  const [newContactName, setNewContactName] = useState('');
  const [addingContact, setAddingContact] = useState(false);

  const addManualContact = async () => {
    const email = newContactEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showToast('כתובת מייל לא תקינה', 'warning');
      return;
    }
    setAddingContact(true);
    try {
      // 1. Push to Resend (source of truth) — uses the existing subscribe action
      await callCampaignFunction(supabase, 'subscribe', {
        email,
        name: newContactName.trim() || undefined,
        userId: user.id,
      });
      // 2. Mirror immediately into Supabase so the UI shows it without waiting
      //    for the next full sync.
      try {
        await marketingContactsDb.insert({
          email,
          name: newContactName.trim() || null,
          opted_in: true,
          source: 'manual',
        });
      } catch (mirrorErr) {
        // Likely a unique constraint hit — already in marketing_contacts.
        // Not fatal; Resend has it now and the next sync will reconcile.
        console.warn('mirror insert skipped:', mirrorErr?.message);
      }
      showToast(`נוסף ${email}`);
      setNewContactEmail('');
      setNewContactName('');
      setShowAddForm(false);
    } catch (err) {
      showToast(`שגיאה: ${err?.message || 'unknown'}`, 'error');
    } finally {
      setAddingContact(false);
    }
  };
  // Contacts synced from Resend (read-only cache in Supabase)
  const contacts = data.marketingContacts || [];
  const optedIn  = contacts.filter(c => c.opted_in).length;
  const optedOut = contacts.length - optedIn;
  const filteredContacts = contacts.filter(c => {
    if (contactFilter === 'opted_in' && !c.opted_in) return false;
    if (contactFilter === 'opted_out' && c.opted_in) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!(c.name || '').toLowerCase().includes(q) && !(c.email || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const syncFromResend = async () => {
    setSyncingResend(true);
    try {
      const result = await callCampaignFunction(supabase, 'sync-resend-contacts', { userId: user.id });
      const removedMsg = result.removed > 0 ? ` (הוסרו ${result.removed} שאינם ב-Resend)` : '';
      syncResendProgress.complete();
      showToast(`סונכרנו ${result.synced} אנשי קשר מ-Resend${removedMsg}`);
    } catch (err) {
      showToast(`שגיאה בסנכרון: ${err.message}`, 'error');
    } finally {
      setSyncingResend(false);
    }
  };

  // Push all opted-in contacts from Supabase → Resend in pages of 500
  const pushAllToResend = async () => {
    setPushingResend(true);
    let totalPushed = 0, totalFailed = 0, offset = 0;
    try {
      while (true) {
        const result = await callCampaignFunction(supabase, 'push-to-resend', {
          userId: user.id, offset, limit: 500,
        });
        totalPushed += result.pushed || 0;
        totalFailed += result.failed || 0;
        offset = result.offset || offset + 500;
        if (result.done || !result.total) break;
      }
      const failMsg = totalFailed > 0 ? ` (${totalFailed} נכשלו)` : '';
      pushResendProgress.complete();
      showToast(`נדחפו ${totalPushed} אנשי קשר ל-Resend${failMsg}`);
    } catch (err) {
      showToast(`שגיאה בדחיפה ל-Resend: ${err.message}`, 'error');
    } finally {
      setPushingResend(false);
    }
  };

  const importFlashyCSV = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be re-selected
    setImportingFlashy(true);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const text = ev.target.result;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { showToast('קובץ ריק', 'warning'); return; }

        // Parse header — detect column indices case-insensitively
        const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
        const idx = (keys) => { for (const k of keys) { const i = header.findIndex(h => h.includes(k)); if (i >= 0) return i; } return -1; };
        const emailIdx  = idx(['email']);
        if (emailIdx < 0) { showToast('לא נמצאה עמודת email בקובץ', 'error'); return; }
        const firstIdx  = idx(['first_name', 'firstname', 'first name', 'שם פרטי']);
        const lastIdx   = idx(['last_name', 'lastname', 'last name', 'שם משפחה']);
        const nameIdx   = idx(['name', 'full_name', 'שם']);
        const phoneIdx  = idx(['phone', 'mobile', 'טלפון']);
        const statusIdx = idx(['status', 'subscription_status', 'subscribed', 'opted_in', 'opt_in']);
        const tagsIdx   = idx(['tags']);

        const APPROVED = new Set(['subscribed', 'active', 'approved', 'yes', '1', 'true', 'opted_in', 'optin']);

        // Fix triple-encoded Hebrew: Flashy exports UTF-8 Hebrew that was
        // misread as CP1252 and re-encoded as UTF-8.
        // Also handles NBSP (0xA0) normalized to SPACE (0x20) for letter נ.
        const fixHebrew = (str) => {
          if (!str || !/[\xC0-\xFF]/.test(str)) return str;
          try {
            // Step 1: encode each char back to a raw byte (CP1252-like)
            const buf = [];
            for (const ch of str) {
              const cp = ch.charCodeAt(0);
              if (cp < 0x80) { buf.push(cp); }
              else if (cp <= 0x9F) { buf.push(cp); }           // undefined CP1252 → direct byte
              else if (cp <= 0xFF) { buf.push(cp); }           // Latin-1 range
              else {
                // For multi-byte Unicode (e.g. U+2018 ' → 0x91, U+2122 ™ → 0x99)
                // Use a minimal reverse-CP1252 table for chars Flashy produces
                const map = { 0x2018:0x91,0x2019:0x92,0x201A:0x82,0x201C:0x93,0x201D:0x94,
                              0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,
                              0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F,
                              0x20AC:0x80,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,
                              0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,
                              0x017D:0x8E };
                buf.push(map[cp] ?? 0x3F); // '?' fallback
              }
            }
            // Step 2: fix D7 + non-continuation (NBSP normalized to SPACE → restore נ)
            const fixed = [];
            for (let i = 0; i < buf.length; i++) {
              if (buf[i] === 0xD7 && i + 1 < buf.length && (buf[i+1] < 0x80 || buf[i+1] > 0xBF)) {
                fixed.push(0xD7, 0xA0); // restore נ (NUN)
                i++;
              } else {
                fixed.push(buf[i]);
              }
            }
            return new TextDecoder('utf-8').decode(new Uint8Array(fixed)).replace(/\uFFFD/g, '');
          } catch { return str; }
        };

        const parseRow = (line) => {
          // Handle quoted CSV values
          const cols = [];
          let cur = '', inQ = false;
          for (const ch of line) {
            if (ch === '"') { inQ = !inQ; }
            else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
            else { cur += ch; }
          }
          cols.push(cur.trim());
          return cols;
        };

        const rows = lines.slice(1).map(parseRow);
        const contacts = rows
          .map(cols => {
            const email = cols[emailIdx]?.replace(/"/g, '').trim().toLowerCase();
            if (!email || !email.includes('@')) return null;

            // Skip if tags contain "unsubscribed" (Flashy format)
            if (tagsIdx >= 0) {
              const tagsRaw = (cols[tagsIdx] || '').replace(/^"|"$/g, '').trim();
              try {
                const tags = tagsRaw ? JSON.parse(tagsRaw) : [];
                if (tags.includes('unsubscribed')) return null;
              } catch {}
            }

            // Skip if explicit status column exists and is not approved
            if (statusIdx >= 0) {
              const status = (cols[statusIdx] || '').replace(/"/g, '').trim().toLowerCase();
              if (status && !APPROVED.has(status)) return null;
            }

            const firstName = fixHebrew(firstIdx >= 0 ? (cols[firstIdx] || '').replace(/"/g, '').trim() : '');
            const lastName  = fixHebrew(lastIdx  >= 0 ? (cols[lastIdx]  || '').replace(/"/g, '').trim() : '');
            const fullName  = nameIdx  >= 0
              ? fixHebrew((cols[nameIdx] || '').replace(/"/g, '').trim())
              : [firstName, lastName].filter(Boolean).join(' ');
            const phone = phoneIdx >= 0 ? (cols[phoneIdx] || '').replace(/"/g, '').trim() : '';
            return { user_id: user.id, email, name: fullName || null, phone: phone || null, source: 'flashy', opted_in: true };
          })
          .filter(Boolean);

        const skipped = rows.length - contacts.length;
        if (contacts.length === 0) {
          showToast(statusIdx >= 0 ? `לא נמצאו אנשי קשר מאושרים (${skipped} לא מאושרים דולגו)` : 'לא נמצאו אנשי קשר תקינים', 'warning');
          return;
        }

        // Upsert in batches of 100
        let imported = 0;
        for (let i = 0; i < contacts.length; i += 100) {
          const batch = contacts.slice(i, i + 100);
          const { error } = await supabase.from('marketing_contacts')
            .upsert(batch, { onConflict: 'user_id,email', ignoreDuplicates: false });
          if (error) throw new Error(error.message);
          imported += batch.length;
        }
        const skippedMsg = skipped > 0 ? ` (${skipped} לא מאושרים דולגו)` : '';
        showToast(`יובאו ${imported} אנשי קשר מ-Flashy${skippedMsg}. דוחף ל-Resend…`);
        marketingContactsDb.refresh();
        // Auto-push all opted-in contacts to Resend (server fetches from Supabase)
        await pushAllToResend();
      } catch (err) {
        showToast(`שגיאה בייבוא: ${err.message}`, 'error');
      } finally {
        setImportingFlashy(false);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  return (
    <section>
      <div className="mkt-sec-head">
        <div>
          <h2>אנשי קשר</h2>
          <p className="mkt-sec-sub">Resend הוא מקור האמת. הרשמות מהאתר נכנסות ישירות ל-Resend, והסנכרון מעדכן את הרשימה כאן.</p>
        </div>
        <button onClick={() => setShowAddForm(v => !v)} className={showAddForm ? 'btn-secondary' : 'btn-primary'} aria-expanded={showAddForm}>
          {showAddForm ? <X size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
          {showAddForm ? 'סגירה' : 'הוספת איש קשר'}
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap mb-4">
        <button onClick={syncFromResend} disabled={syncingResend || pushingResend} className="btn-secondary mkt-btn-sm">
          <Download size={16} aria-hidden="true" />
          {syncingResend ? 'מסנכרן…' : 'סנכרון מ-Resend'}
        </button>
        <button onClick={pushAllToResend} disabled={pushingResend || syncingResend} className="btn-secondary mkt-btn-sm">
          <Upload size={16} aria-hidden="true" />
          {pushingResend ? 'דוחף…' : 'דחיפה ל-Resend'}
        </button>
        <label className={importingFlashy ? 'cursor-not-allowed' : 'cursor-pointer'}>
          <input type="file" accept=".csv" className="sr-only" onChange={importFlashyCSV} disabled={importingFlashy} />
          <span className={`btn-secondary mkt-btn-sm ${importingFlashy ? 'pointer-events-none opacity-60' : ''}`}>
            <FileText size={16} aria-hidden="true" />
            {importingFlashy ? 'מייבא…' : 'ייבוא CSV מ-Flashy'}
          </span>
        </label>
        <a
          href="https://resend.com/audience?limit=120"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost mkt-btn-sm"
        >
          ניהול ב-Resend
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>

      {/* Manual add contact form */}
      {showAddForm && (
        <div className="card mb-4">
          <h3 className="mkt-card-title mb-1"><UserPlus size={16} aria-hidden="true" />הוספה ידנית</h3>
          <p className="text-[13px] text-surface-500 mb-3">
            איש הקשר נוסף ל-Resend ולרשימה המקומית מיד, בלי צורך בסנכרון.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              type="email"
              value={newContactEmail}
              onChange={e => setNewContactEmail(e.target.value)}
              placeholder="example@gmail.com"
              aria-label="כתובת מייל"
              dir="ltr"
              className="field mkt-mono w-auto flex-[2_1_220px]"
              onKeyDown={e => { if (e.key === 'Enter') addManualContact(); }}
              autoFocus
            />
            <input
              type="text"
              value={newContactName}
              onChange={e => setNewContactName(e.target.value)}
              placeholder="שם (לא חובה)"
              aria-label="שם"
              className="field w-auto flex-[1_1_140px]"
              onKeyDown={e => { if (e.key === 'Enter') addManualContact(); }}
            />
            <button
              onClick={addManualContact}
              disabled={addingContact || !newContactEmail.trim()}
              className="btn-primary"
            >
              {addingContact ? 'מוסיף…' : 'הוספה'}
            </button>
          </div>
        </div>
      )}

      {/* Progress bars for long-running contact ops */}
      {syncingResend && (
        <div className="mb-4" role="status">
          <ProgressBar progress={syncResendProgress.progress} label="מסנכרן אנשי קשר מ-Resend…" color={BRAND} height={6} />
        </div>
      )}
      {pushingResend && (
        <div className="mb-4" role="status">
          <ProgressBar progress={pushResendProgress.progress} label="דוחף אנשי קשר ל-Resend…" color={BRAND} height={6} />
        </div>
      )}

      {/* Stats row */}
      <div className="mkt-kpis cols-3 mb-4">
        <div className="mkt-kpi">
          <div className="k-label">מאושרים</div>
          <div className="k-value">{optedIn}</div>
        </div>
        <div className="mkt-kpi">
          <div className="k-label">הוסרו</div>
          <div className="k-value">{optedOut}</div>
        </div>
        <div className="mkt-kpi">
          <div className="k-label">סה״כ</div>
          <div className="k-value">{contacts.length}</div>
        </div>
      </div>

      <div className="card-flush overflow-hidden">
        <div className="card-head flex-wrap">
          {/* Filter tabs */}
          <div className="mkt-seg" role="group" aria-label="סינון לפי סטטוס">
            {[
              { id: 'all', label: 'הכל', count: contacts.length },
              { id: 'opted_in', label: 'מאושרים', count: optedIn },
              { id: 'opted_out', label: 'הוסרו', count: optedOut },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setContactFilter(f.id)}
                aria-pressed={contactFilter === f.id}
              >
                {f.label} <span className="num">{f.count}</span>
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="mkt-search flex-[1_1_220px] max-w-[360px] ms-auto">
            <Search size={16} aria-hidden="true" />
            <input className="field"
              type="text"
              placeholder="חיפוש לפי שם או מייל"
              aria-label="חיפוש אנשי קשר לפי שם או מייל"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setVisibleCount(50); }}
            />
          </div>
          {searchQuery && (
            <p className="w-full text-xs text-surface-500" aria-live="polite">
              נמצאו <span className="num">{filteredContacts.length}</span> תוצאות
            </p>
          )}
        </div>

        {/* Contacts table */}
        {filteredContacts.length > 0 ? (
          <>
            <div className="mkt-table-wrap">
              <table className="mkt-table">
                <thead>
                  <tr>
                    <th>שם</th>
                    <th>מייל</th>
                    <th>סטטוס</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredContacts.slice(0, visibleCount).map(c => (
                    <tr key={c.id}>
                      <td className="font-medium">{c.name || <span className="text-surface-400">—</span>}</td>
                      <td className="text-surface-700 text-[13px]"><span dir="ltr" className="break-all">{c.email}</span></td>
                      <td>
                        <span className={c.opted_in ? 'tag tag-ok' : 'tag'}>
                          {c.opted_in ? 'מאושר' : 'הוסר'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-t border-surface-200">
              <p className="text-xs text-surface-500">
                <span className="num">{Math.min(visibleCount, filteredContacts.length)}</span> מתוך <span className="num">{filteredContacts.length}</span> מוצגים
              </p>
              {filteredContacts.length > visibleCount && (
                <button
                  onClick={() => setVisibleCount(prev => prev + 50)}
                  className="btn-secondary mkt-btn-sm"
                >
                  הצגת עוד <span className="num text-surface-500">(נותרו {filteredContacts.length - visibleCount})</span>
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="mkt-empty">
            <Users size={20} aria-hidden="true" />
            {contacts.length === 0
              ? 'אין אנשי קשר עדיין. "סנכרון מ-Resend" טוען את הרשימה.'
              : 'אין תוצאות לסינון הנוכחי.'
            }
          </div>
        )}
      </div>
    </section>
  );
}

// ── Groups Tab ──────────────────────────────────────────────────────────────

function GroupsTab({ data, showToast, contactGroupsDb, contactGroupMembersDb }) {
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [isTestDraft, setIsTestDraft] = useState(false);
  const [saving, setSaving] = useState(false);

  const groups = data.contactGroups || [];
  const members = data.contactGroupMembers || [];
  const contacts = data.marketingContacts || [];

  // Member counts per group
  const countByGroup = new Map();
  for (const m of members) {
    countByGroup.set(m.group_id, (countByGroup.get(m.group_id) || 0) + 1);
  }

  const resetForm = () => {
    setShowCreate(false);
    setEditingId(null);
    setNameDraft('');
    setDescDraft('');
    setIsTestDraft(false);
  };

  const saveGroup = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      showToast('שם הקבוצה חובה', 'warning');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await contactGroupsDb.update(editingId, {
          name: trimmed,
          description: descDraft.trim() || null,
          is_test_group: isTestDraft,
          updated_at: new Date().toISOString(),
        });
        showToast('הקבוצה עודכנה');
      } else {
        await contactGroupsDb.insert({
          name: trimmed,
          description: descDraft.trim() || null,
          is_test_group: isTestDraft,
        });
        showToast('הקבוצה נוצרה');
      }
      resetForm();
    } catch (err) {
      showToast(`שגיאה: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async (group) => {
    const memberCount = countByGroup.get(group.id) || 0;
    const confirmMsg = memberCount > 0
      ? `למחוק את הקבוצה "${group.name}" ו-${memberCount} חברים?`
      : `למחוק את הקבוצה "${group.name}"?`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await contactGroupsDb.remove(group.id);
      await contactGroupMembersDb.refresh();
      showToast('הקבוצה נמחקה');
    } catch (err) {
      showToast(`שגיאה: ${err.message}`, 'error');
    }
  };

  const startEdit = (group) => {
    setEditingId(group.id);
    setNameDraft(group.name || '');
    setDescDraft(group.description || '');
    setIsTestDraft(!!group.is_test_group);
    setShowCreate(true);
  };

  return (
    <section>
      <div className="mkt-sec-head">
        <div>
          <h2>קבוצות אנשי קשר</h2>
          <p className="mkt-sec-sub max-w-[620px]">
            קבוצה מאפשרת לשלוח קמפיין לחלק מאנשי הקשר. קבוצה שמסומנת כ"קבוצת בדיקה" מקבלת כפתור שליחה מהיר במחולל.
          </p>
        </div>
        {!showCreate && (
          <button onClick={() => setShowCreate(true)} className="btn-primary">
            <Plus size={16} aria-hidden="true" />
            קבוצה חדשה
          </button>
        )}
      </div>

      {/* Create / edit form */}
      {showCreate && (
        <div className="card mb-4">
          <h3 className="mkt-card-title">
            {editingId ? 'עריכת קבוצה' : 'קבוצה חדשה'}
          </h3>
          <div className="mkt-stack-sm">
            <label className="mkt-field">
              <span className="field-label">שם הקבוצה</span>
              <input className="field"
                type="text"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                placeholder="למשל: לקוחות VIP, צוות בדיקה, בעלי Jura"
                autoFocus
              />
            </label>
            <label className="mkt-field">
              <span className="field-label">תיאור <span className="font-normal text-surface-500">(לא חובה)</span></span>
              <input className="field"
                type="text"
                value={descDraft}
                onChange={e => setDescDraft(e.target.value)}
                placeholder="למה משמשת הקבוצה"
              />
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer min-h-[32px] pt-1">
              <input
                type="checkbox"
                checked={isTestDraft}
                onChange={e => setIsTestDraft(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-surface-900">
                קבוצת בדיקה
                <span className="block text-xs text-surface-500 mt-0.5">מוסיפה כפתור שליחה מהיר במחולל המיילים</span>
              </span>
            </label>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={saveGroup} disabled={saving} className="btn-primary">
              <Save size={16} aria-hidden="true" />
              {saving ? 'שומר…' : 'שמירה'}
            </button>
            <button onClick={resetForm} className="btn-ghost">ביטול</button>
          </div>
        </div>
      )}

      {/* Groups list */}
      {groups.length === 0 ? (
        <div className="card-flush overflow-hidden mkt-empty">
          <FolderOpen size={20} aria-hidden="true" />
          אין קבוצות עדיין. "קבוצה חדשה" פותחת את הטופס.
        </div>
      ) : (
        <div className="card-flush overflow-hidden mkt-rows">
          {groups.map(g => (
            <GroupRow
              key={g.id}
              group={g}
              memberCount={countByGroup.get(g.id) || 0}
              members={members.filter(m => m.group_id === g.id)}
              contacts={contacts}
              contactGroupMembersDb={contactGroupMembersDb}
              onEdit={() => startEdit(g)}
              onDelete={() => deleteGroup(g)}
              showToast={showToast}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GroupRow({ group, memberCount, members, contacts, contactGroupMembersDb, onEdit, onDelete, showToast }) {
  const [expanded, setExpanded] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [manualEmail, setManualEmail] = useState('');

  const memberEmails = new Set(members.map(m => (m.email || '').toLowerCase()));

  const addContact = async (c) => {
    const email = (c.email || '').toLowerCase().trim();
    if (!email || memberEmails.has(email)) return;
    try {
      await contactGroupMembersDb.insert({ group_id: group.id, email, name: c.name || null });
      setMemberSearch('');
    } catch (err) {
      showToast(`שגיאה: ${err.message}`, 'error');
    }
  };

  const addManualEmail = async () => {
    const email = manualEmail.toLowerCase().trim();
    if (!email || !email.includes('@')) {
      showToast('כתובת מייל לא תקינה', 'warning');
      return;
    }
    if (memberEmails.has(email)) {
      showToast('המייל כבר בקבוצה', 'warning');
      return;
    }
    try {
      await contactGroupMembersDb.insert({ group_id: group.id, email, name: null });
      setManualEmail('');
    } catch (err) {
      showToast(`שגיאה: ${err.message}`, 'error');
    }
  };

  const removeMember = async (memberId) => {
    try {
      await contactGroupMembersDb.remove(memberId);
    } catch (err) {
      showToast(`שגיאה: ${err.message}`, 'error');
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-surface-900">{group.name}</span>
            {group.is_test_group && (
              <span className="tag tag-warn">קבוצת בדיקה</span>
            )}
          </div>
          <div className="text-xs text-surface-500 mt-0.5">
            <span className="num">{memberCount}</span> חברים{group.description ? ` · ${group.description}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setExpanded(v => !v)} className="btn-secondary mkt-btn-sm" aria-expanded={expanded}>
            <Users size={16} aria-hidden="true" />
            {expanded ? 'הסתרה' : 'חברים'}
          </button>
          <button onClick={onEdit} className="mkt-icon-btn" aria-label={`עריכת הקבוצה ${group.name}`} title="עריכה">
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button onClick={onDelete} className="mkt-icon-btn danger" aria-label={`מחיקת הקבוצה ${group.name}`} title="מחיקה">
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-surface-200 flex flex-col gap-2.5">
          {/* Current members */}
          {members.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {members.map(m => (
                <span key={m.id} className="mkt-token" dir="ltr">
                  <span>{m.email}</span>
                  <button
                    onClick={() => removeMember(m.id)}
                    aria-label={`הסרת ${m.email} מהקבוצה`}
                  ><X size={12} aria-hidden="true" /></button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-surface-500">
              אין חברים בקבוצה עדיין.
            </p>
          )}

          {/* Add manual email */}
          <div className="flex gap-2">
            <input
              type="email"
              value={manualEmail}
              onChange={e => setManualEmail(e.target.value)}
              placeholder="הוספת מייל (למשל tester@gmail.com)"
              aria-label="הוספת מייל לקבוצה"
              dir="auto"
              className="field mkt-mono flex-1 min-w-0"
              onKeyDown={e => { if (e.key === 'Enter') addManualEmail(); }}
            />
            <button onClick={addManualEmail} className="btn-secondary w-[38px] px-0" aria-label="הוספת המייל לקבוצה">
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>

          {/* Pick from existing contacts */}
          <div className="mkt-search">
            <Search size={16} aria-hidden="true" />
            <input className="field"
              type="text"
              value={memberSearch}
              onChange={e => setMemberSearch(e.target.value)}
              placeholder="חיפוש באנשי הקשר הקיימים"
              aria-label="חיפוש באנשי הקשר הקיימים"
            />
          </div>
          {memberSearch.trim() && (
            <div className="mkt-pick mkt-rows max-h-[200px] overflow-y-auto">
              {contacts
                .filter(c => c.opted_in)
                .filter(c => {
                  const q = memberSearch.toLowerCase();
                  return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
                })
                .slice(0, 20)
                .map(c => {
                  const already = memberEmails.has((c.email || '').toLowerCase());
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => !already && addContact(c)}
                      disabled={already}
                      className="mkt-opt"
                    >
                      <span className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[13px] font-medium text-surface-900">{c.name || '—'}</span>
                        <span className="text-xs text-surface-500 truncate" dir="ltr">{c.email}</span>
                      </span>
                      {already
                        ? <span className="inline-flex items-center gap-1 text-xs text-surface-500 shrink-0"><Check size={14} aria-hidden="true" />בקבוצה</span>
                        : <Plus size={16} aria-hidden="true" className="text-surface-500 shrink-0" />}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({ data, user, showToast, onDuplicate, onEdit }) {
  const [expandedId, setExpandedId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);
  const [resumingId, setResumingId] = useState(null);

  const handleResume = async (c) => {
    const remaining = (data.marketing_contacts || []).filter(mc => mc.opted_in).length - (c.recipient_count || 0);
    if (remaining <= 0) {
      showToast('כל הנמענים כבר קיבלו את הקמפיין', 'info');
      return;
    }
    if (!window.confirm(`לשלוח את הקמפיין ל-${remaining} הנותרים שטרם קיבלו?`)) return;
    setResumingId(c.id);
    try {
      const result = await callCampaignFunction(supabase, 'send-campaign', {
        userId: user.id,
        campaignId: c.id,
        resume: true,
      });
      const errMsg = result.errorCount > 0 ? ` (${result.errorCount} שגיאות)` : '';
      showToast(`נשלח ל-${result.sent} נמענים נוספים${errMsg}`);
    } catch (err) {
      showToast(`שגיאה: ${err.message}`, 'error');
    } finally {
      setResumingId(null);
    }
  };

  const campaigns = (data.campaigns || []).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  const toggleExpand = (campaign) => {
    if (expandedId === campaign.id) {
      setExpandedId(null);
      if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(''); }
    } else {
      setExpandedId(campaign.id);
      if (campaign.html_content) {
        const blob = new Blob([campaign.html_content], { type: 'text/html;charset=utf-8' });
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(blob));
      } else {
        setPreviewUrl('');
      }
    }
  };

  const statusLabel = (s) =>
    s === 'sent' ? 'נשלח' : s === 'failed' ? 'נכשל' : 'טיוטה';
  const statusClass = (s) =>
    s === 'sent' ? 'tag tag-ok' : s === 'failed' ? 'tag tag-danger' : 'tag';

  return (
    <section>
      <div className="mkt-sec-head">
        <div>
          <h2>היסטוריית קמפיינים</h2>
          <p className="mkt-sec-sub">
            <span className="num">{campaigns.length}</span> קמפיינים. לחיצה על שורה פותחת פרטים ותצוגה של המייל.
          </p>
        </div>
      </div>

      {campaigns.length > 0 ? (
        <div className="card-flush overflow-hidden">
          {/* Select all + bulk actions */}
          <div className="card-head flex-wrap">
            <label className="inline-flex items-center gap-2.5 text-[13px] text-surface-700 cursor-pointer min-h-[32px]">
              <input
                type="checkbox"
                checked={selectedIds.size === campaigns.length && campaigns.length > 0}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedIds(new Set(campaigns.map(c => c.id)));
                  } else {
                    setSelectedIds(new Set());
                  }
                }}
              />
              בחירת הכל
            </label>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap ms-auto">
          <span className="text-[13px] font-medium text-surface-900">
            <span className="num">{selectedIds.size}</span> נבחרו
          </span>
          <button
            onClick={async () => {
              if (!window.confirm(`למחוק ${selectedIds.size} קמפיינים?`)) return;
              setDeleting(true);
              try {
                const { error: delErr } = await supabase.from('campaigns').delete().in('id', [...selectedIds]);
                if (delErr) throw delErr;
                showToast(`${selectedIds.size} קמפיינים נמחקו`);
                setSelectedIds(new Set());
                setExpandedId(null);
              } catch (err) {
                showToast(`שגיאה: ${err.message}`, 'error');
              } finally {
                setDeleting(false);
              }
            }}
            disabled={deleting}
            className="btn-quiet-danger mkt-btn-sm"
          >
            <Trash2 size={16} aria-hidden="true" />
            {deleting ? 'מוחק…' : `מחיקת ${selectedIds.size}`}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="btn-ghost mkt-btn-sm"
          >
            ביטול הבחירה
          </button>
        </div>
      )}
          </div>

          <div className="mkt-rows">
          {campaigns.map(c => (
            <div key={c.id} className={selectedIds.has(c.id) ? 'bg-brand-50' : ''}>
              {/* Campaign row */}
              <div className="flex items-center gap-3 ps-4">
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    setSelectedIds(prev => {
                      const next = new Set(prev);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    });
                  }}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`בחירת הקמפיין ${c.subject || 'ללא נושא'}`}
                />
                <button
                  type="button"
                  onClick={() => toggleExpand(c)}
                  className="mkt-press flex-1 min-w-0 py-3 pe-3"
                  aria-expanded={expandedId === c.id}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-surface-900 truncate">
                      {c.subject || 'ללא נושא'}
                    </span>
                    <span className="flex gap-x-2 gap-y-0.5 items-center flex-wrap text-xs text-surface-500 mt-0.5">
                      <span className="num">{new Date(c.created_at).toLocaleDateString('he-IL')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1">
                        {c.channel === 'email'
                          ? <><Mail size={12} aria-hidden="true" />מייל</>
                          : <><MessageCircle size={12} aria-hidden="true" />WhatsApp</>}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span><span className="num">{c.recipient_count || 0}</span> נמענים</span>
                    </span>
                  </span>
                  <span className={statusClass(c.status)}>{statusLabel(c.status)}</span>
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className="mkt-chev text-surface-400 shrink-0"
                  />
                </button>
              </div>

              {/* Expanded detail */}
              {expandedId === c.id && (
                <div className="px-4 pb-4 pt-1 flex flex-col gap-3">
                  {/* Stats row */}
                  <div className={`mkt-kpis ${c.sent_at ? 'cols-4' : 'cols-3'}`}>
                    <div className="mkt-kpi">
                      <div className="k-label">נשלחו</div>
                      <div className="k-value">{c.recipient_count || 0}</div>
                    </div>
                    <div className="mkt-kpi">
                      <div className="k-label">פתחו</div>
                      <div className="k-value">{c.open_count || '—'}</div>
                    </div>
                    <div className="mkt-kpi">
                      <div className="k-label">לחצו</div>
                      <div className="k-value">{c.click_count || '—'}</div>
                    </div>
                    {c.sent_at && (
                      <div className="mkt-kpi">
                        <div className="k-label">נשלח בתאריך</div>
                        <div className="k-value sm">
                          {new Date(c.sent_at).toLocaleString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Error info */}
                  {c.error && (
                    <div className="notice notice-danger">
                      <TriangleAlert size={16} aria-hidden="true" />
                      <span dir="ltr" className="text-start break-words min-w-0">{c.error}</span>
                    </div>
                  )}

                  {/* HTML preview */}
                  {previewUrl && (
                    <div className="mkt-field">
                      <span className="field-label inline-flex items-center gap-1.5"><Eye size={14} aria-hidden="true" className="text-surface-500" />תצוגת המייל</span>
                      <iframe
                        src={previewUrl}
                        className="mkt-preview h-[400px]"
                        title="Campaign Preview"
                      />
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={(e) => { e.stopPropagation(); onDuplicate(c); }}
                      className="btn-primary mkt-btn-sm"
                    >
                      <Copy size={16} aria-hidden="true" />
                      שכפול הקמפיין
                    </button>
                    {c.status === 'draft' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onEdit(c); }}
                        className="btn-secondary mkt-btn-sm"
                      >
                        <Pencil size={16} aria-hidden="true" />
                        המשך עריכה
                      </button>
                    )}
                    {c.status === 'sent' && c.channel === 'email' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleResume(c); }}
                        disabled={resumingId === c.id}
                        className="btn-secondary mkt-btn-sm"
                        title="שליחה לאלו שעוד לא קיבלו (מדלג על אלו שכבר קיבלו)"
                      >
                        <Send size={16} aria-hidden="true" />
                        {resumingId === c.id ? 'שולח…' : 'שליחה לנותרים'}
                      </button>
                    )}
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`למחוק את הקמפיין "${c.subject}"?`)) return;
                        try {
                          const { error: delErr } = await supabase.from('campaigns').delete().eq('id', c.id);
                          if (delErr) throw delErr;
                          showToast('הקמפיין נמחק');
                          setExpandedId(null);
                        } catch (err) {
                          showToast(`שגיאה: ${err.message}`, 'error');
                        }
                      }}
                      className="btn-quiet-danger mkt-btn-sm ms-auto"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      מחיקה
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          </div>
        </div>
      ) : (
        <div className="card-flush overflow-hidden mkt-empty">
          <History size={20} aria-hidden="true" />
          אין קמפיינים עדיין. הקמפיין הראשון נוצר בלשונית "קמפיין אוטומטי".
        </div>
      )}
    </section>
  );
}


// ── Stop / resume reorder reminders for one customer ───────────────────────
// Customers' own data lives in service-role-only tables, so the lookup goes
// through email-automation-scheduler (admin-gated) rather than the table API.
function ReminderStopPanel({ showToast }) {
  const { user: clerkUser } = useUser();
  const actor = clerkUser?.primaryEmailAddress?.emailAddress ?? null;
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const call = async (body) => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('email-automation-scheduler', { body });
      if (error || data?.error) throw new Error(data?.error ?? error.message);
      setStatus(data);
      return data;
    } catch (e) {
      showToast(`שגיאה: ${e.message}`, 'error');
      return null;
    } finally { setBusy(false); }
  };

  const lookup = () => {
    const e = email.trim().toLowerCase();
    if (!e.includes('@')) { showToast('כתובת מייל לא תקינה', 'error'); return; }
    call({ action: 'reminder_status', email: e });
  };
  const setStopped = async (stop) => {
    const d = await call({ action: 'set_reminders', email: email.trim().toLowerCase(), stop, actor });
    if (d) showToast(stop ? 'התזכורות ללקוח הופסקו' : 'התזכורות ללקוח חודשו');
  };

  return (
    <div className="card mt-6">
      <h3 className="mkt-card-title mb-1"><PauseCircle size={16} aria-hidden="true" />הפסקת תזכורות ללקוח</h3>
      <p className="text-[13px] text-surface-500 mb-3 text-pretty">
        מחפשים לפי כל כתובת מייל של הלקוח. הפסקה כאן זהה ללחיצה של הלקוח על "להפסקת תזכורות" במייל.
      </p>
      <div className="flex gap-2 flex-wrap">
        <input type="email" value={email} onChange={e => { setEmail(e.target.value); setStatus(null); }}
          placeholder="customer@example.com" dir="ltr" className="field w-auto flex-[1_1_220px] max-w-[360px]"
          aria-label="כתובת המייל של הלקוח"
          onKeyDown={e => { if (e.key === 'Enter') lookup(); }} />
        <button className="btn-secondary" onClick={lookup} disabled={busy}>
          <Search size={16} aria-hidden="true" />
          חיפוש
        </button>
      </div>
      {status && !status.found && (
        <p className="mt-3 text-[13px] text-surface-500">לא נמצא לקוח עם הכתובת הזו.</p>
      )}
      {status?.found && (
        <div className="mt-3 pt-3 border-t border-surface-200 flex gap-3 items-center flex-wrap">
          <span className="text-sm text-surface-900"><span className="num font-medium">{status.paid_orders}</span> הזמנות</span>
          <span className={status.reminders_stopped ? 'tag tag-warn' : 'tag tag-ok'}>
            {status.reminders_stopped ? 'תזכורות מופסקות' : 'תזכורות פעילות'}
          </span>
          {status.last_reminder_at && (
            <span className="text-[13px] text-surface-500">
              תזכורת אחרונה: <span className="num">{new Date(status.last_reminder_at).toLocaleDateString('he-IL')}</span>
            </span>
          )}
          <button className="btn-secondary mkt-btn-sm ms-auto" disabled={busy} onClick={() => setStopped(!status.reminders_stopped)}>
            {status.reminders_stopped ? 'חידוש תזכורות' : 'הפסקת תזכורות'}
          </button>
        </div>
      )}
    </div>
  );
}
