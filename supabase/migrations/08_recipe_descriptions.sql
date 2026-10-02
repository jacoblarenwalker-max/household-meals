-- One-line descriptions for the household's recipes (shown under the dinner name on This week).
-- Written from each recipe itself (Mel's Kitchen Cafe pages), not from the week's cooking notes.
-- Only fills recipes that don't have a description yet, so later edits in the app are kept.
update public.recipes r set description = v.description
from (values
  ('7fcca8a3-ebab-492d-b117-d3f5d9cca25f'::uuid, 'Cheesy baked spaghetti made in one skillet'),
  ('64a506fa-7f31-4421-b211-b711a2a6ab6f'::uuid, 'Creamy chicken and white bean chili with green chiles'),
  ('18339593-38eb-4d0d-9abe-fcb9703713b4'::uuid, 'Honey garlic chicken roasted with broccoli and peppers'),
  ('e0b33fbb-be0d-436c-befc-7cb07fd648f1'::uuid, 'Chili-spiced beef or turkey with beans over rice'),
  ('b4028be0-03f4-4a3f-b203-354c4f73b854'::uuid, 'Veggie, bean and pasta soup in a tomato broth'),
  ('9e940c2b-8e8e-4a03-967c-22941469d5c3'::uuid, 'Sweet-savory ground beef and rice with a crunchy slaw'),
  ('5d1c6e50-1dd8-48de-8452-ec43982bd7cd'::uuid, 'One-skillet penne with chicken sausage, squash and spinach'),
  ('4447a763-127b-430a-a4e3-3b6b1a09281b'::uuid, 'Smoky brown-sugar rubbed pork tenderloin, air fried')
) as v(id, description)
where r.id = v.id and (r.description is null or r.description = v.description);
