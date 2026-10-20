// Safe merge: adds the weekend non-veg items to your existing menu.json without touching anything else.
// Run once:  node add-nonveg.js
const fs=require('fs'),path=require('path');
const F=path.join(process.env.DATA_DIR || __dirname,'menu.json');
const menu=JSON.parse(fs.readFileSync(F,'utf8'));
const when='Available Friday, Saturday and Sunday only.';
const mk=(id,name,name2,desc,category)=>({id,name,desc:desc+' '+when,name2,desc2:'',price:null,priceLabel:'Ask for price',category,veg:false,special:false,tags:[],img:'',available:true});
const items=[
  mk('k1','Khorada Soup','ਖਰੋੜਾ','Traditional Punjabi goat-leg soup, slow cooked with desi tadka.','Weekend Soups'),
  mk('k2','Chicken Soup','ਚਿਕਨ ਸੂਪ','Hearty soup with fresh chicken, vegetables and spices.','Weekend Soups'),
  mk('k3','Goat Meat','ਬੱਕਰੇ ਦਾ ਮੀਟ','Tender goat meat cooked in traditional Punjabi spices.','Weekend Curries'),
  mk('k4','Boiler Chicken','ਦੇਸੀ ਕੁੱਕੜ','Healthy desi chicken curry with traditional spices.','Weekend Curries')
];
const fresh=items.filter(i=>!menu.some(m=>m.id===i.id));
if(!fresh.length){console.log('Already added.');process.exit(0)}
let at=menu.map(m=>m.category).lastIndexOf('Protein Meal');
at=at<0?menu.length:at+1;
menu.splice(at,0,...fresh);
fs.writeFileSync(F,JSON.stringify(menu,null,1));
console.log('Added '+fresh.length+' items.');
