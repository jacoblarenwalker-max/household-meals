// Grocery aisle categorizer: free, offline, client-side. categorize('Great Value 2% milk, 1 gal') -> 'Dairy & Eggs'.
// How it works: tidy the text (drop sizes/counts/brand filler), try every 1-3 word phrase against the dictionary
// (with plural variants), prefer the match nearest the end (the head noun: "chicken broth" -> broth), then the
// longer phrase ("peanut butter" beats "butter"); "frozen"/"canned" win outright. No hit -> a small typo-tolerant
// pass (e.g. "bananna", "cerial", "papertowels"), then 'Other'.

export const GROCERY_CATEGORIES = ['Produce', 'Dairy & Eggs', 'Meat', 'Bakery & Bread', 'Pantry', 'Canned Goods', 'Frozen',
  'Snacks', 'Drinks', 'Breakfast & Cereal', 'Condiments & Spices', 'Household & Cleaning', 'Paper Goods', 'Personal Care',
  'Baby', 'Pet', 'Other'];

// older category names (and common synonyms) -> the current aisle list
const LEGACY = {
  dairy: 'Dairy & Eggs', eggs: 'Dairy & Eggs', 'dairy and eggs': 'Dairy & Eggs', 'dairy & eggs': 'Dairy & Eggs',
  bakery: 'Bakery & Bread', bread: 'Bakery & Bread', 'bakery and bread': 'Bakery & Bread',
  spices: 'Condiments & Spices', spice: 'Condiments & Spices', condiments: 'Condiments & Spices', 'condiments and spices': 'Condiments & Spices', seasonings: 'Condiments & Spices',
  'breakfast basics': 'Breakfast & Cereal', breakfast: 'Breakfast & Cereal', cereal: 'Breakfast & Cereal', 'breakfast and cereal': 'Breakfast & Cereal',
  household: 'Household & Cleaning', cleaning: 'Household & Cleaning', 'household and cleaning': 'Household & Cleaning',
  meat: 'Meat', 'meat and seafood': 'Meat', 'meat & seafood': 'Meat', seafood: 'Meat', deli: 'Meat', protein: 'Meat',
  canned: 'Canned Goods', 'canned goods': 'Canned Goods', 'canned food': 'Canned Goods',
  frozen: 'Frozen', 'frozen foods': 'Frozen', snack: 'Snacks', snacks: 'Snacks',
  drinks: 'Drinks', beverages: 'Drinks', beverage: 'Drinks', paper: 'Paper Goods', 'paper goods': 'Paper Goods',
  'personal care': 'Personal Care', 'health and beauty': 'Personal Care', toiletries: 'Personal Care', pharmacy: 'Personal Care',
  baby: 'Baby', pet: 'Pet', pets: 'Pet', produce: 'Produce', fruit: 'Produce', vegetables: 'Produce', pantry: 'Pantry', other: 'Other',
};
const tidyKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
const CANON = Object.fromEntries(GROCERY_CATEGORIES.map((c) => [tidyKey(c), c]));
// any stored category -> one of GROCERY_CATEGORIES when it maps; unknown custom names are kept as typed
export function canonCategory(c) {
  const k = tidyKey(c);
  if (!k) return 'Other';
  return CANON[k] || LEGACY[k] || LEGACY[k.replace(/ and /g, ' & ')] || String(c).trim();
}

// phrase lists per aisle (singular forms; plurals are matched automatically)
const WORDS = {
  'Produce': `fruit, fresh fruit, vegetable, veggie, produce, apple, banana, orange, mandarin, clementine, cutie, grape, grapefruit,
    strawberry, blueberry, raspberry, blackberry, berry, mixed berry, lemon, lime, avocado, tomato, cherry tomato, grape tomato,
    roma tomato, potato, russet, sweet potato, yam, onion, red onion, yellow onion, green onion, scallion, shallot, garlic, garlic bulb,
    carrot, baby carrot, celery, broccoli, cauliflower, lettuce, romaine, iceberg, spinach, baby spinach, kale, arugula, salad,
    salad kit, salad mix, spring mix, coleslaw mix, cucumber, zucchini, squash, butternut squash, spaghetti squash, pepper,
    bell pepper, jalapeno, poblano, mushroom, corn, corn on the cob, peach, pear, plum, nectarine, melon, watermelon,
    cantaloupe, honeydew, pineapple, mango, kiwi, cherry, pomegranate, papaya, green bean, snap pea, snow pea, pea, asparagus,
    cabbage, brussels sprout, sprout, radish, beet, turnip, parsnip, eggplant, leek, cilantro, parsley, basil leaf, fresh basil,
    fresh herb, mint, dill, ginger, ginger root, pumpkin, artichoke, okra, bok choy, edible flower, fig, date, apricot, coconut,
    plantain, guava, persimmon, rhubarb, tomatillo, microgreen`,
  'Dairy & Eggs': `milk, whole milk, skim milk, 2 milk, chocolate milk, almond milk, oat milk, soy milk, lactose free milk, egg, egg white,
    butter, salted butter, unsalted butter, margarine, cheese, cheddar, mozzarella, parmesan, parmigiano, swiss, provolone,
    pepper jack, colby, monterey jack, colby jack, american cheese, feta, ricotta, gouda, brie, string cheese, shredded cheese,
    sliced cheese, cheese stick, cream cheese, neufchatel, cottage cheese, yogurt, yoghurt, greek yogurt, yogurt cup, kefir,
    sour cream, heavy cream, heavy whipping cream, whipping cream, whipped cream, cool whip, half and half, creamer,
    coffee creamer, buttermilk, eggnog, refrigerated biscuit, crescent roll, cookie dough, pudding cup`,
  'Meat': `meat, chicken, chicken breast, chicken thigh, chicken leg, drumstick, chicken wing, wing, whole chicken, rotisserie chicken,
    ground chicken, beef, ground beef, hamburger, hamburger meat, burger patty, steak, sirloin, ribeye, flank steak, roast,
    chuck roast, pot roast, brisket, stew meat, pork, pork chop, pork loin, pork tenderloin, tenderloin, pork shoulder, rib,
    bacon, turkey bacon, sausage, breakfast sausage, italian sausage, bratwurst, brat, kielbasa, chorizo, ham, deli ham,
    turkey, ground turkey, deli turkey, lunch meat, deli meat, cold cut, salami, pepperoni, bologna, hot dog, frank, lamb,
    veal, fish, salmon, tilapia, cod, halibut, mahi, catfish, trout, shrimp, scallop, crab, lobster, tuna steak, seafood,
    meatball`,
  'Bakery & Bread': `bread, white bread, wheat bread, whole wheat bread, sourdough, rye, loaf, bun, hamburger bun, hot dog bun, slider bun,
    roll, dinner roll, hoagie, sub roll, bagel, english muffin, muffin, croissant, tortilla, flour tortilla, corn tortilla,
    wrap, pita, naan, flatbread, baguette, french bread, texas toast, garlic bread, biscuit, donut, doughnut, cake, cupcake,
    pie, pie crust, brownie, danish, cinnamon roll, breadstick, bread crumb, crouton`,
  'Pantry': `rice, white rice, brown rice, jasmine rice, instant rice, pasta, spaghetti, penne, macaroni, rotini, fettuccine, linguine,
    lasagna, egg noodle, noodle, ramen, orzo, couscous, quinoa, lentil, dried bean, mac and cheese, mac n cheese, kraft dinner,
    flour, all purpose flour, sugar, brown sugar, powdered sugar, baking soda, baking powder, yeast, cornstarch, cornmeal,
    vanilla, vanilla extract, extract, cocoa powder, chocolate chip, baking chip, sprinkle, cake mix, brownie mix,
    muffin mix, cornbread mix, frosting, oil, olive oil, vegetable oil, canola oil, coconut oil, avocado oil, cooking spray,
    shortening, peanut butter, almond butter, nutella, jelly, jam, preserve, honey, molasses, pasta sauce, spaghetti sauce,
    marinara, alfredo, alfredo sauce, pesto, pizza sauce, stuffing, instant potato, mashed potato mix, gravy, gravy mix,
    bouillon, breadcrumb, panko, dried fruit, raisin, crasin, cranberry sauce, gelatin, jello, pudding mix, marshmallow,
    graham cracker, evaporated milk, condensed milk, sweetened condensed milk, powdered milk, nonfat dry milk, boxed meal,
    hamburger helper, rice a roni, side dish, taco shell, tostada, taco kit, tortilla shell`,
  'Canned Goods': `canned, can of, bean, black bean, pinto bean, kidney bean, navy bean, great northern bean, cannellini, garbanzo, chickpea,
    refried bean, baked bean, chili bean, soup, chicken noodle soup, tomato soup, cream of chicken, cream of mushroom,
    broth, chicken broth, beef broth, vegetable broth, stock, chicken stock, tomato sauce, tomato paste, diced tomato,
    crushed tomato, whole tomato, stewed tomato, rotel, green chile, diced green chile, chile, enchilada sauce, tuna,
    canned tuna, canned chicken, salmon can, sardine, spam, chili, olive, black olive, pickle, artichoke heart, pumpkin puree,
    canned fruit, fruit cocktail, mandarin orange cup, applesauce, coconut milk, water chestnut, bamboo shoot, sauerkraut,
    canned corn, cream corn, creamed corn, canned vegetable`,
  'Frozen': `frozen, ice cream, gelato, sherbet, popsicle, ice pop, frozen yogurt, pizza, frozen pizza, pizza roll, tater tot, tot,
    french fry, fry, hash brown, waffle, eggo, frozen vegetable, frozen fruit, frozen berry, frozen pea, frozen corn,
    chicken nugget, nugget, chicken tender, chicken strip, fish stick, burrito, frozen burrito, frozen dinner, tv dinner,
    lean cuisine, pot pie, egg roll, dumpling, potsticker, edamame, ice, bag of ice, cool whip, frozen meal, lasagna frozen,
    frozen waffle, toaster strudel, ice cream sandwich, ice cream bar, frozen fish, frozen shrimp, mixed vegetable,
    stir fry vegetable, steamable`,
  'Snacks': `snack, chip, potato chip, tortilla chip, corn chip, dorito, cheeto, frito, lays, pringle, ruffle, tostito, sun chip,
    pretzel, popcorn, cracker, goldfish, cheez it, ritz, triscuit, wheat thin, cookie, oreo, chips ahoy, candy, chocolate,
    chocolate bar, candy bar, gummy, gummies, gummy bear, fruit snack, fruit gummy, fruit roll up, licorice, mint candy, gum,
    nut, peanut, almond, cashew, pistachio, walnut, pecan, mixed nut, trail mix, sunflower seed, pumpkin seed, jerky,
    beef jerky, granola bar, protein bar, cereal bar, nature valley, kind bar, clif bar, rice krispie treat, rice cake,
    pudding, salsa, queso, dip, hummus, guacamole, veggie straw, pirate booty, animal cracker, teddy graham, fig newton,
    nilla wafer, little debbie, snack cake, cheese puff`,
  'Drinks': `drink, beverage, water, bottled water, spring water, sparkling water, seltzer, la croix, bubly, mineral water, soda, pop,
    coke, coca cola, diet coke, pepsi, sprite, dr pepper, root beer, ginger ale, mountain dew, juice, orange juice,
    apple juice, grape juice, cranberry juice, lemonade, fruit punch, capri sun, juice box, gatorade, powerade,
    sports drink, electrolyte, energy drink, red bull, monster, coffee, ground coffee, coffee bean, k cup, kcup, coffee pod,
    instant coffee, cold brew, tea, tea bag, green tea, iced tea, sweet tea, kombucha, hot cocoa, hot chocolate,
    drink mix, kool aid, crystal light, mio, beer, wine, coconut water, protein shake, smoothie`,
  'Breakfast & Cereal': `cereal, cheerio, frosted flake, corn flake, raisin bran, rice krispie, cinnamon toast crunch, lucky charm,
    froot loop, honey nut cheerio, special k, life cereal, chex, kix, granola, oat, rolled oat, quick oat, oatmeal,
    instant oatmeal, steel cut oat, cream of wheat, grits, pancake mix, waffle mix, bisquick, syrup, maple syrup,
    pancake syrup, pop tart, toaster pastry, breakfast bar, nutri grain, breakfast`,
  'Condiments & Spices': `condiment, ketchup, catsup, mustard, dijon, yellow mustard, mayo, mayonnaise, miracle whip, ranch, dressing,
    salad dressing, salt and pepper, italian dressing, vinaigrette, bbq sauce, barbecue sauce, hot sauce, sriracha, buffalo sauce, soy sauce,
    teriyaki, teriyaki sauce, worcestershire, steak sauce, a1, relish, horseradish, tartar sauce, cocktail sauce, sauce,
    vinegar, apple cider vinegar, balsamic, salt, kosher salt, sea salt, black pepper, peppercorn, ground pepper,
    seasoning, taco seasoning, italian seasoning, cajun seasoning, seasoning salt, lemon pepper, spice, garlic powder,
    garlic salt, onion powder, chili powder, paprika, smoked paprika, cumin, ground cumin, oregano, dried basil, thyme,
    rosemary, sage, bay leaf, cinnamon, nutmeg, clove, allspice, ginger powder, ground ginger, turmeric, curry, curry powder,
    cayenne, red pepper flake, crushed red pepper, chili flake, dried parsley, dill weed, powder, rub, marinade,
    everything bagel seasoning, msg, bouillon cube, salsa verde, gochujang, fish sauce, oyster sauce, hoisin`,
  'Household & Cleaning': `household, cleaning, cleaner, all purpose cleaner, detergent, laundry, laundry detergent, laundry pod, tide,
    gain, fabric softener, dryer sheet, downy, bleach, clorox, lysol, disinfectant, disinfecting wipe, cleaning wipe, wipe,
    windex, glass cleaner, dish soap, dawn, dishwasher detergent, dishwasher pod, cascade, finish, rinse aid, sponge,
    scrub brush, scrubber, steel wool, magic eraser, swiffer, mop, broom, dustpan, trash bag, garbage bag, kitchen bag,
    hefty, glad, aluminum foil, foil, tin foil, plastic wrap, cling wrap, saran wrap, wax paper, parchment paper, ziploc,
    zip bag, sandwich bag, freezer bag, storage bag, food storage, light bulb, lightbulb, battery, air freshener,
    febreze, candle, matches, lighter, extension cord, rubber glove, toilet bowl cleaner, drain cleaner, pest, bug spray,
    mouse trap, shoe polish, stain remover, oxiclean, shout`,
  'Paper Goods': `paper towel, paper towel roll, toilet paper, bath tissue, tp, napkin, paper napkin, tissue, facial tissue, kleenex, puffs,
    paper plate, plate, paper bowl, paper cup, plastic cup, solo cup, disposable cup, plastic fork, plastic spoon,
    plastic utensil, cutlery, straw, coffee filter, bounty, charmin, scott, cottonelle, quilted northern, angel soft,
    viva, brawny, cupcake liner, muffin liner, paper goods`,
  'Personal Care': `personal care, shampoo, conditioner, body wash, shower gel, soap, bar soap, hand soap, hand sanitizer, toothpaste,
    tooth paste, toothbrush, tooth brush, floss, dental floss, mouthwash, deodorant, antiperspirant, razor, razor blade,
    shaving cream, shave gel, lotion, body lotion, moisturizer, sunscreen, sunblock, chapstick, lip balm, cotton ball,
    cotton swab, q tip, qtip, band aid, bandaid, bandage, first aid, tylenol, advil, ibuprofen, acetaminophen, aspirin,
    allergy medicine, medicine, cough drop, cold medicine, vitamin, multivitamin, supplement, melatonin, tampon,
    feminine pad, pad, panty liner, contact solution, makeup, mascara, nail polish, hair spray, hairspray, hair gel,
    hair tie, comb, hairbrush, dry shampoo, face wash, cleanser, makeup remover, eye drop, nasal spray, condom,
    pregnancy test, epsom salt`,
  'Baby': `baby, diaper, pull up, pullup, baby wipe, wet wipe, formula, infant formula, baby formula, baby food, puree pouch,
    pouch, baby cereal, teether, pacifier, sippy cup, baby bottle, bottle nipple, baby shampoo, baby wash, baby lotion,
    diaper cream, desitin, huggies, pampers, luvs, rash cream, nursing pad, breast pad`,
  'Pet': `pet, pet food, dog, dog food, puppy pad, pee pad, training pad, wee wee pad, puppy, dog treat, puppy food, cat, cat food, cat treat, kitten food, kibble, wet food, cat litter,
    litter, kitty litter, poop bag, dog bag, rawhide, chew toy, dog chew, bone, flea, tick, flea treatment, fish food,
    bird seed, birdseed, hamster, guinea pig, pet toy, purina, pedigree, meow mix, friskies, fancy feast, blue buffalo,
    iams, milk bone, greenies`,
};

// words that settle it no matter what else is in the name
const STRONG = { frozen: 'Frozen', canned: 'Canned Goods' };
// sizes, counts and filler that never decide the aisle
const SIZE_RE = /\b\d+(?:[.,/]\d+)?\s*-?\s*(?:x\s*)?(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|ct|count|pk|packs?|pc|pcs|pieces?|rolls?|mega rolls?|double rolls?|gal|gallons?|qt|quarts?|pt|pints?|l|liters?|litres?|ml|dozen|doz|cans?|bottles?|bags?|boxes|box|jars?|cartons?|sheets?|loads?|cups?|tubs?|lb\.)\b/g;
const FILLER = new Set(['great', 'value', 'equate', 'mainstays', 'marketside', 'freshness', 'guaranteed', 'organic', 'fresh',
  'family', 'size', 'party', 'large', 'small', 'medium', 'jumbo', 'extra', 'xl', 'mini', 'big', 'pack', 'value pack', 'bulk',
  'brand', 'store', 'the', 'a', 'an', 'some', 'for', 'with', 'of', 'to', 'in', 'my', 'our', 'more', 'new', 'fat', 'free',
  'low', 'reduced', 'sodium', 'light', 'lite', 'original', 'classic', 'regular', 'plain', 'whole', 'and', 'or', 'n', 'kids']);

const variants = (w) => {
  const out = new Set([w]);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) out.add(w.slice(0, -1));
  if (w.length > 4 && w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('ies')) out.add(w.slice(0, -3) + 'y');
  if (w.length > 4 && w.endsWith('ves')) { out.add(w.slice(0, -3) + 'f'); out.add(w.slice(0, -3) + 'fe'); }
  return [...out];
};
const clean = (s) => String(s || '').toLowerCase()
  .replace(/[’']/g, '').replace(/&/g, ' and ').replace(/\bw\//g, ' with ')
  .replace(SIZE_RE, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b\d+(?:\s+\d+)*\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

// dictionary: phrase (space-joined, every word singular-ish) -> category
const DICT = new Map();
const SINGLE = []; // single-word keys for the typo pass
for (const [cat, list] of Object.entries(WORDS)) {
  for (const raw of list.split(',')) {
    const p = clean(raw);
    if (!p || DICT.has(p)) continue; // first list wins for a duplicate phrase
    DICT.set(p, cat);
    if (!p.includes(' ') && p.length >= 4) SINGLE.push(p);
  }
}
const JOINED = new Map([...DICT].filter(([p]) => p.includes(' ')).map(([p, c]) => [p.replace(/ /g, ''), c]));

function lookup(words) {
  // all spellings of a phrase: each word as typed or as a singular variant
  let combos = [''];
  for (const w of words) {
    const next = [];
    for (const c of combos) for (const v of variants(w)) next.push(c ? `${c} ${v}` : v);
    combos = next;
  }
  for (const c of combos) if (DICT.has(c)) return DICT.get(c);
  return null;
}

// optimal string alignment distance, stops early past `max`
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

// returns { category, match, how } — how: 'strong' | 'exact' | 'joined' | 'fuzzy' | 'none'
export function explainCategory(name) {
  const all = clean(name).split(' ').filter(Boolean); // filler stays in for phrases ("mac and cheese", "light bulb")
  const words = all.filter((w) => !FILLER.has(w));    // ...and is dropped for the run-together and typo passes
  if (!all.length) return { category: 'Other', match: null, how: 'none' };
  for (const w of all) for (const v of variants(w)) if (STRONG[v]) return { category: STRONG[v], match: v, how: 'strong' };
  let best = null;
  for (let end = all.length; end >= 1; end--) {
    for (let len = Math.min(3, end); len >= 1; len--) {
      const phrase = all.slice(end - len, end);
      const cat = lookup(phrase);
      if (cat) { best = { category: cat, match: phrase.join(' '), how: 'exact' }; break; }
    }
    if (best) break;
  }
  if (best) return best;
  // run-together words ("papertowels", "icecream")
  const joined = words.join('');
  for (const v of variants(joined)) if (JOINED.has(v)) return { category: JOINED.get(v), match: v, how: 'joined' };
  for (const v of variants(joined)) if (DICT.has(v)) return { category: DICT.get(v), match: v, how: 'joined' };
  // typos: closest single dictionary word (1 edit for short words, 2 for long ones), later words first
  let fz = null;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.length < 4) continue;
    const max = w.length >= 7 ? 2 : 1;
    for (const k of SINGLE) {
      for (const v of variants(w)) {
        const d = editDistance(v, k, max);
        if (d <= max && (!fz || d < fz.d)) fz = { d, k, i };
      }
    }
    if (fz) break;
  }
  if (fz) return { category: DICT.get(fz.k), match: fz.k, how: 'fuzzy' };
  return { category: 'Other', match: null, how: 'none' };
}
export const categorize = (name) => explainCategory(name).category;
