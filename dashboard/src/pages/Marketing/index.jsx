// Marketing page — thin shell that owns tab state and routes to per-tab files.
//
// This file used to be a 2,500-line monolith (Marketing.jsx) that defined
// every tab inline. Splitting it out lets us:
//   - keep each tab's logic in its own file (easier to read, smaller diffs)
//   - render only the active tab (smaller render cost per nav)
//   - isolate render crashes to a single tab (the page-level ErrorBoundary
//     catches them without taking down neighboring routes)

import { useState } from 'react';
import { useApp } from '../../lib/context';
import { TABS } from './constants';
import { AutoComposeTab } from './AutoComposeTab';
import { AutomationsTab } from './AutomationsTab';
import { ContactsTab } from './ContactsTab';
import { GroupsTab } from './GroupsTab';
import { HistoryTab } from './HistoryTab';

export default function Marketing() {
  const {
    data,
    user,
    showToast,
    marketingContactsDb,
    campaignsDb,
    contactGroupsDb,
    contactGroupMembersDb,
  } = useApp();

  const [activeTab, setActiveTab] = useState('compose');
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

  return (
    <div className="page">
      <h1>📧 Marketing</h1>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={activeTab === tab.id ? 'btn-primary' : 'btn-small'}
            style={{ fontSize: '0.9rem' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'compose' && (
        <AutoComposeTab
          data={data}
          user={user}
          showToast={showToast}
          duplicateData={duplicateData}
          clearDuplicate={() => setDuplicateData(null)}
          editData={editData}
          clearEdit={() => setEditData(null)}
          campaignsDb={campaignsDb}
        />
      )}
      {activeTab === 'automations' && (
        <AutomationsTab data={data} user={user} showToast={showToast} />
      )}
      {activeTab === 'contacts' && (
        <ContactsTab
          data={data}
          user={user}
          showToast={showToast}
          marketingContactsDb={marketingContactsDb}
        />
      )}
      {activeTab === 'groups' && (
        <GroupsTab
          data={data}
          showToast={showToast}
          contactGroupsDb={contactGroupsDb}
          contactGroupMembersDb={contactGroupMembersDb}
        />
      )}
      {activeTab === 'history' && (
        <HistoryTab
          data={data}
          user={user}
          showToast={showToast}
          onDuplicate={handleDuplicate}
          onEdit={handleEdit}
        />
      )}
    </div>
  );
}
