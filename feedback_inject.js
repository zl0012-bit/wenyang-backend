// [FEEDBACK] 打通前端「关于我们 · 意见反馈」表单 → 后台「反馈管理」页
// 主站 bundle 的 AboutContact 表单提交后仅做前端提示、未真正持久化。
// 本项目为纯前端部署（无真实后端），本脚本在捕获阶段的 submit 事件中读取字段，
// 将反馈持久化到 localStorage（key 与后台「反馈管理」页一致），
// 并把成功提示文案更新为「已记录至后台反馈管理」，与现有中国风 UI 风格保持一致。
// 采用轮询绑定以兼容 Vue 异步挂载 / SPA 路由切换。
(function(){
  var FB_KEY='wenyao:feedbacks';
  function readFB(){try{return JSON.parse(localStorage.getItem(FB_KEY))||[];}catch(e){return [];}}
  function saveFB(arr){try{localStorage.setItem(FB_KEY,JSON.stringify(arr));}catch(e){}}
  function validEmail(e){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);}
  function bind(){
    var form=document.querySelector('.about-contact__form');
    if(!form||form.dataset.fbBound)return;
    form.dataset.fbBound='1';
    // 捕获阶段：在 Vue 清空输入框之前把字段读出来
    form.addEventListener('submit',function(){
      var nameI=form.querySelector('input[type=text]');
      var emailI=form.querySelector('input[type=email]');
      var sel=form.querySelector('select');
      var ta=form.querySelector('textarea');
      var name=nameI?nameI.value:'';
      var email=emailI?emailI.value:'';
      var type=sel?sel.value:'建议';
      var content=ta?ta.value:'';
      // 校验未通过时交给 Vue 自己提示，不写入
      if(!name.trim()||!email.trim()||!content.trim()||!validEmail(email))return;
      var arr=readFB();
      var id='FB-'+String(Date.now()).slice(-6)+'-'+Math.floor(Math.random()*900+100);
      arr.unshift({id:id,name:name.trim(),email:email.trim(),type:type,
        content:content.trim(),time:Date.now(),status:'待处理'});
      saveFB(arr);
      // 友好提示：替换为已记录到后台的文案（覆盖「演示：未真正发送」）
      setTimeout(function(){
        var ok=document.querySelector('.about-contact__ok');
        if(ok)ok.textContent='已收到你的反馈，谢谢！我们已记录至后台「反馈管理」。';
      },0);
    },true);
  }
  setInterval(bind,700);
  bind();
})();
