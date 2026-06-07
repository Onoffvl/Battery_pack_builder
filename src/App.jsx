import React from 'react';
import BatteryPackDesigner from './BatteryPackDesigner.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Battery Pack Designer</h1>
        <p>Wire cells in series and parallel and watch the pack spec build in real time.</p>
      </header>
      <BatteryPackDesigner />
    </div>
  );
}
