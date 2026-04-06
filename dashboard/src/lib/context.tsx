/**
 * Dashboard App Context
 * Loads marketing + product data from CoffeeFlow Supabase for use
 * in the Marketing (email generator) and AI Analyst pages.
 */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'

interface AppContextValue {
  data: {
    products: any[]
    marketingContacts: any[]
    campaigns: any[]
    packingLogs: any[]
    pendingOrders: any[]
  }
  user: { id: string } | null
  marketingContactsDb: {
    insert: (item: any) => Promise<any>
    update: (id: any, updates: any) => Promise<any>
    remove: (id: any) => Promise<void>
    refresh: () => Promise<void>
  }
  campaignsDb: {
    insert: (item: any) => Promise<any>
    update: (id: any, updates: any) => Promise<any>
    remove: (id: any) => Promise<void>
    refresh: () => Promise<void>
  }
  showToast: (msg: string, type?: string) => void
  refreshAll: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

function useTable(table: string) {
  const [data, setData] = useState<any[]>([])

  const fetchData = useCallback(async () => {
    const { data: rows } = await supabase.from(table).select('*')
    setData(rows || [])
  }, [table])

  useEffect(() => { fetchData() }, [fetchData])

  const insert = async (item: any) => {
    const { data: result, error } = await supabase.from(table).insert(item).select().single()
    if (error) throw error
    await fetchData()
    return result
  }

  const update = async (id: any, updates: any) => {
    const { data: result, error } = await supabase.from(table).update(updates).eq('id', id).select().single()
    if (error) throw error
    await fetchData()
    return result
  }

  const remove = async (id: any) => {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) throw error
    await fetchData()
  }

  return { data, refresh: fetchData, insert, update, remove }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  const productsDb        = useTable('products')
  const marketingContactsDb = useTable('marketing_contacts')
  const campaignsDb       = useTable('campaigns')
  const packingLogsDb     = useTable('packing_logs')
  const pendingOrdersDb   = useTable('pending_orders')

  const showToast = (msg: string, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const refreshAll = async () => {
    await Promise.all([
      productsDb.refresh(),
      marketingContactsDb.refresh(),
      campaignsDb.refresh(),
      packingLogsDb.refresh(),
      pendingOrdersDb.refresh(),
    ])
  }

  const value: AppContextValue = {
    data: {
      products:         productsDb.data,
      marketingContacts: marketingContactsDb.data,
      campaigns:        campaignsDb.data,
      packingLogs:      packingLogsDb.data,
      pendingOrders:    pendingOrdersDb.data,
    },
    user: { id: 'dashboard-user' },
    marketingContactsDb,
    campaignsDb,
    showToast,
    refreshAll,
  }

  return (
    <AppContext.Provider value={value}>
      {children}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: toast.type === 'error' ? '#DC2626' : '#2c1a0e',
          color: '#fff', padding: '12px 24px', borderRadius: 12,
          fontSize: '0.9rem', zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          animation: 'fadeUp 0.2s ease',
        }}>
          {toast.msg}
        </div>
      )}
    </AppContext.Provider>
  )
}
