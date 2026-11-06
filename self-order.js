'use strict';
(() => {
  const SCALE = { normal: 1, large: 1.45, xlarge: 1.75 };
  const THEME = { default: 'theme-sage-metal', dark: 'theme-navy-steel', light: 'theme-ivory-gold' };
  const state = { products: [], category: '', cart: new Map() };
  let trackingTimer = null;
  const $ = selector => document.querySelector(selector);
  const money = value => `${new Intl.NumberFormat('ar-EG',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0)} ج.م`;
  function setAppearance() {
    let theme = localStorage.getItem('system_selected_theme') || 'theme-sage-metal';
    if (!Object.values(THEME).includes(theme)) theme = THEME.default;
    document.body.classList.remove(...Object.values(THEME)); document.body.classList.add(theme); $('#theme-choice').value = theme;
    let size = localStorage.getItem('system_font_size_guest') || 'large';
    if (!Object.hasOwn(SCALE, size)) size = 'large';
    document.body.dataset.fontSize = size; document.documentElement.style.setProperty('--rawda-font-scale', String(SCALE[size])); $('#font-choice').value = size;
  }
  function saveAppearance() {
    const theme = $('#theme-choice').value, size = $('#font-choice').value;
    localStorage.setItem('system_selected_theme', theme); localStorage.setItem('system_font_size_guest', size);
    document.body.classList.remove(...Object.values(THEME)); document.body.classList.add(theme);
    document.body.dataset.fontSize = size; document.documentElement.style.setProperty('--rawda-font-scale', String(SCALE[size]));
  }
  function visibleProducts() {
    const search = $('#product-search').value.trim().toLocaleLowerCase('ar');
    return state.products.filter(product => (!state.category || product.category_name === state.category) && (!search || `${product.name} ${product.category_name}`.toLocaleLowerCase('ar').includes(search)));
  }
  function renderCategories() {
    const host = $('#category-list'); host.replaceChildren();
    const values = ['', ...new Set(state.products.map(product => product.category_name))];
    for (const value of values) { const button = document.createElement('button'); button.type='button'; button.className='category-chip'; button.textContent=value || 'الكل'; button.setAttribute('aria-pressed', String(state.category === value)); button.addEventListener('click', () => { state.category=value; renderCategories(); renderProducts(); }); host.append(button); }
  }
  function renderProducts() {
    const host = $('#product-grid'); host.replaceChildren(); const rows=visibleProducts();
    $('#catalog-status').textContent=rows.length ? `${rows.length} صنف متاح` : 'لا توجد منتجات مطابقة حالياً.';
    for (const product of rows) {
      const card=document.createElement('article'); card.className='product-card'; card.dataset.productId=String(product.id);
      const image=document.createElement('div'); image.className='product-image';
      if(product.image_url){const img=document.createElement('img');img.src=product.image_url;img.alt=product.name;img.loading='lazy';image.append(img);}else{image.textContent='صورة المنتج';}
      const title=document.createElement('h3'); title.textContent=product.name;
      const category=document.createElement('p'); category.className='product-meta';category.textContent=product.category_name;
      const footer=document.createElement('div');footer.className='product-card-footer';
      const price=document.createElement('strong');price.className='product-price';price.textContent=money(product.price);
      const add=document.createElement('button');add.type='button';add.className='add-button';add.setAttribute('aria-label',`إضافة ${product.name} للسلة`);add.textContent='+';add.addEventListener('click',()=>addItem(product.id));
      footer.append(price,add);card.append(image,title,category,footer);host.append(card);
    }
  }
  function addItem(id) { const product=state.products.find(row=>row.id===id);if(!product)return;const existing=state.cart.get(id);state.cart.set(id,{product,quantity:Math.min(99,(existing?.quantity||0)+1)});renderCart(); }
  function changeQuantity(id,delta) { const item=state.cart.get(id);if(!item)return;const quantity=item.quantity+delta;if(quantity<=0)state.cart.delete(id);else item.quantity=Math.min(99,quantity);renderCart(); }
  function renderCart() {
    const host=$('#cart-items');host.replaceChildren();let count=0,total=0;
    for(const [id,item] of state.cart){count+=item.quantity;total+=item.product.price*item.quantity;const row=document.createElement('div');row.className='cart-row';const title=document.createElement('span');title.className='cart-row-title';title.textContent=`${item.product.name} — ${money(item.product.price*item.quantity)}`;const controls=document.createElement('div');controls.className='cart-controls';for(const [label,delta] of [['−',-1],['+',1]]){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',`${delta>0?'زيادة':'تقليل'} ${item.product.name}`);button.addEventListener('click',()=>changeQuantity(id,delta));controls.append(button);}const qty=document.createElement('span');qty.textContent=String(item.quantity);controls.append(qty);row.append(title,controls);host.append(row);}
    if(!count){const empty=document.createElement('p');empty.className='empty-cart';empty.textContent='أضف منتجاتك لتظهر هنا.';host.append(empty);}
    $('#cart-count').textContent=String(count);$('#cart-total').textContent=money(total);$('#submit-order').disabled=count===0;
  }
  function showOrderMessage(message) { const result=$('#order-result');result.textContent=message;result.classList.remove('hidden'); }
  async function checkTrackedOrder(tracking) {
    try {
      const response=await fetch(`/api/public/self-order/orders/${encodeURIComponent(tracking.id)}/status?token=${encodeURIComponent(tracking.token)}`,{cache:'no-store'});
      if(response.ok){const data=await response.json();showOrderMessage(data.message);if(['accepted','rejected','expired','completed'].includes(data.status))return;}
    } catch (_) {}
    trackingTimer=setTimeout(()=>checkTrackedOrder(tracking),10000);
  }
  function trackOrder(tracking) {
    if(trackingTimer)clearTimeout(trackingTimer);
    try{localStorage.setItem('system_self_order_tracking',JSON.stringify(tracking));}catch(_){}
    checkTrackedOrder(tracking);
  }
  async function loadCatalog(){try{const response=await fetch('/api/public/self-order/catalog',{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'تعذر تحميل المنتجات.');state.products=data.products||[];if(data.business?.business_name)$('#business-name').textContent=data.business.business_name;renderCategories();renderProducts();}catch(error){$('#catalog-status').textContent=error.message;}}
  $('#fulfillment').addEventListener('change',()=>$('#address-field').classList.toggle('hidden',$('#fulfillment').value!=='delivery'));
  $('#product-search').addEventListener('input',renderProducts);
  $('#theme-choice').addEventListener('change',saveAppearance);$('#font-choice').addEventListener('change',saveAppearance);
  $('#order-form').addEventListener('submit',async event=>{event.preventDefault();if(!state.cart.size)return;const button=$('#submit-order');button.disabled=true;const result=$('#order-result');result.classList.add('hidden');try{const items=[...state.cart.values()].map(item=>({product_id:item.product.id,quantity:item.quantity}));const response=await fetch('/api/public/self-order/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_order_key:crypto.randomUUID(),customer_name:$('#customer-name').value,customer_phone:$('#customer-phone').value,fulfillment:$('#fulfillment').value,address:$('#customer-address').value,note:$('#order-note').value,items})});const data=await response.json();if(!response.ok)throw new Error(data.error||'تعذر إرسال الطلب.');showOrderMessage(`تم استلام الطلب رقم ${data.order.id}. الإجمالي التقديري ${money(data.order.total)}. سيراجع المتجر التوفر قبل التأكيد.`);if(data.status_token)trackOrder({id:data.order.id,token:data.status_token});state.cart.clear();renderCart();}catch(error){result.textContent=error.message;result.classList.remove('hidden');}finally{button.disabled=state.cart.size===0;}});
  setAppearance();renderCart();loadCatalog();
  try{const saved=JSON.parse(localStorage.getItem('system_self_order_tracking')||'null');if(saved?.id&&saved?.token)trackOrder(saved);}catch(_){}
})();
