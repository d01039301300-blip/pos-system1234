/* world-class-ui.js - The Final Cleanup */
(function () {
  const css = `
  /* إخفاء كل الزحمة اللي في الفاتورة */
  #pos-invoice-header, 
  #pos-session-tools, 
  #pos-navigation-tools, 
  #pos-order-type-compact, 
  #pos-invoice-options,
  #pos-payment-details,
  #pos-pricing-details {
    display: none !important;
  }

  /* ترتيب الفاتورة بشكل نظيف جداً */
  #pos-invoice-column > div {
    display: flex !important;
    flex-direction: column !important;
    gap: 12px !important;
    padding: 15px !important;
    background: #ffffff !important;
    border-radius: 20px !important;
    box-shadow: 0 10px 30px rgba(0,0,0,0.08) !important;
    height: 100% !important;
  }

  /* اختيار العميل */
  #pos-customer-picker {
    display: flex !important;
    gap: 8px !important;
    margin: 0 !important;
  }
  #pos-customer-picker select, #pos-customer-picker input {
    height: 55px !important;
    font-size: 16px !important;
    border: 2px solid #e2e8f0 !important;
    border-radius: 12px !important;
    background: #f8fafc !important;
  }

  /* السلة */
  #pos-cart-items {
    flex: 1 1 auto !important;
    min-height: 250px !important;
    border: 2px solid #e2e8f0 !important;
    border-radius: 15px !important;
    background: #f8fafc !important;
    padding: 10px !important;
    overflow-y: auto !important;
  }
  .pos-cart-product-name {
    font-size: 18px !important;
    font-weight: 800 !important;
  }

  /* الإجمالي */
  #pos-invoice-summary {
    background: #fff1f2 !important;
    padding: 15px !important;
    border-radius: 15px !important;
    border: 2px solid #fecdd3 !important;
    margin: 0 !important;
  }
  #pos-final-total-row {
    display: flex !important;
    justify-content: space-between !important;
    font-size: 24px !important;
    font-weight: 900 !important;
    color: #be123c !important;
  }

  /* طرق الدفع */
  #pos-touch-payment-actions .grid {
    display: grid !important;
    grid-template-columns: repeat(4, 1fr) !important;
    gap: 10px !important;
    margin-top: 10px !important;
  }
  .pay-method-btn {
    height: 60px !important;
    font-size: 16px !important;
    font-weight: 900 !important;
    border-radius: 12px !important;
    background: #ffffff !important;
    border: 2px solid #cbd5e1 !important;
    color: #334155 !important;
  }
  .pay-method-btn[class*="bg-[#D6336C]"] {
    background: #be123c !important;
    color: white !important;
    border-color: #be123c !important;
  }

  /* زر إتمام البيع */
  #pos-touch-sale-actions {
    margin-top: 10px !important;
  }
  #pos-touch-sale-actions button {
    height: 70px !important;
    font-size: 24px !important;
    font-weight: 900 !important;
    background: #15803d !important; 
    color: white !important;
    border-radius: 15px !important;
    width: 100% !important;
    box-shadow: 0 6px 20px rgba(21,128,61,0.3) !important;
    border: none !important;
  }

  /* المنتجات وشريط البحث */
  #pos-search-panel {
    background: #ffffff !important;
    padding: 15px !important;
    border-radius: 20px !important;
    border: 2px solid #e2e8f0 !important;
  }
  #pos-search-panel input {
    height: 55px !important;
    font-size: 16px !important;
    border: 2px solid #cbd5e1 !important;
    border-radius: 12px !important;
  }
  .pos-product-card {
    border-radius: 15px !important;
    border: 2px solid #e2e8f0 !important;
    min-height: 140px !important;
  }
  .pos-product-name {
    font-size: 16px !important;
    font-weight: 800 !important;
  }
  .pos-product-price {
    font-size: 18px !important;
    font-weight: 900 !important;
    color: #be123c !important;
  }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();