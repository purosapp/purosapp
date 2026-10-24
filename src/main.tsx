import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { StandaloneVisualizerPage } from './App'
import './index.css'
import { startWindowActivityWatch } from './services/windowActivity'

const isStandaloneVisualizer = new URLSearchParams(window.location.search).has('visualizer')

startWindowActivityWatch()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isStandaloneVisualizer ? <StandaloneVisualizerPage /> : <App />}
  </React.StrictMode>,
)
