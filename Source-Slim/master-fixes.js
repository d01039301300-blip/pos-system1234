document.addEventListener('DOMContentLoaded', () => {
    // إضافة زرار العين لكلمة المرور
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    passwordInputs.forEach(input => {
        if (!input.parentElement.classList.contains('password-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'password-wrapper';
            input.parentNode.insertBefore(wrapper, input);
            wrapper.appendChild(input);

            const eye = document.createElement('span');
            eye.className = 'toggle-password-eye';
            eye.innerHTML = '👁️';
            eye.onclick = () => {
                if (input.type === 'password') {
                    input.type = 'text';
                    eye.innerHTML = '🙈';
                } else {
                    input.type = 'password';
                    eye.innerHTML = '👁️';
                }
            };
            wrapper.appendChild(eye);
        }
    });

    // إضافة زرار "إضافة مورد" في شاشة الموردين
    const supplierScreen = document.querySelector('#suppliers-screen, .suppliers-container');
    if (supplierScreen && !document.getElementById('add-supplier-btn')) {
        const addBtn = document.createElement('button');
        addBtn.id = 'add-supplier-btn';
        addBtn.className = 'btn btn-primary';
        addBtn.innerText = '➕ إضافة مورد جديد';
        addBtn.style.cssText = 'margin: 10px; padding: 10px 20px; font-weight: bold;';
        addBtn.onclick = () => {
            const modal = document.querySelector('#supplier-modal');
            if(modal) modal.style.display = 'flex';
            else alert('يرجى إضافة مودال للموردين في الكود الأساسي');
        };
        supplierScreen.prepend(addBtn);
    }

    // إصلاح الترجمة الديناميكية
    const translateDynamicContent = () => {
        if (localStorage.getItem('lang') === 'en') {
            document.querySelectorAll('[data-ar]').forEach(el => {
                if(el.innerText !== el.getAttribute('data-en') && el.getAttribute('data-en')) {
                    el.innerText = el.getAttribute('data-en');
                }
            });
        }
    };
    const observer = new MutationObserver(() => translateDynamicContent());
    observer.observe(document.body, { childList: true, subtree: true });
});
