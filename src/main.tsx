import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { StoreProvider } from './app/store';
import App from './App';
import GlobalLoading from './components/GlobalLoading';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <App />
        <GlobalLoading />
      </StoreProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
