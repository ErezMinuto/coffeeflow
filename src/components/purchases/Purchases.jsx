import React from 'react';
import MFlowSync from '../../MFlowSync';
import { useApp } from '../../lib/context';

export default function Purchases() {
  const { data, showToast } = useApp();

  return (
    <div className="page">
      <h1>🛒 Purchases</h1>
      <MFlowSync data={data} showToast={showToast} />
    </div>
  );
}
